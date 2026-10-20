import Foundation

/// Just enough HTTP/1.1 for the phone-to-phone server: request heads, bodies
/// with Content-Length (what URLSession, OkHttp and Node send), responses.
/// The socket side lives in the app (Network.framework); this part is plain
/// Foundation so it is tested on Linux too.
public struct HTTPRequest: Sendable {
    public let method: String
    public let path: String
    public let query: [String: String]
    public let headers: [String: String]
    public var body: Data
    public let remoteAddress: String

    public init(method: String, path: String, query: [String: String] = [:], headers: [String: String] = [:], body: Data = Data(), remoteAddress: String = "") {
        self.method = method
        self.path = path
        self.query = query
        self.headers = headers
        self.body = body
        self.remoteAddress = remoteAddress
    }

    public var json: [String: Any]? { try? JSONSerialization.jsonObject(with: body) as? [String: Any] }

    public var wantsClose: Bool { headers["connection"]?.lowercased() == "close" }
}

public struct HTTPResponse: Sendable {
    public let status: Int
    public let body: Data
    public let type: String

    public init(status: Int, body: Data = Data(), type: String = "application/json") {
        self.status = status
        self.body = body
        self.type = type
    }

    public static func json(_ status: Int, _ object: [String: Any] = [:]) -> HTTPResponse {
        HTTPResponse(status: status, body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8))
    }

    public func serialized(close: Bool) -> Data {
        var head = "HTTP/1.1 \(status) \(HTTPWire.reason(status))\r\n"
        head += "Content-Type: \(type)\r\n"
        head += "Content-Length: \(body.count)\r\n"
        head += "Cache-Control: no-store\r\n"
        head += close ? "Connection: close\r\n\r\n" : "Connection: keep-alive\r\n\r\n"
        return Data(head.utf8) + body
    }
}

public enum HTTPWire {
    public static let maxHead = 16 * 1024
    public static let maxBody = 2 * 1024 * 1024 + 64 * 1024

    /// A parsed request head and how many body bytes follow it.
    public struct Head {
        public let method: String
        public let path: String
        public let query: [String: String]
        public let headers: [String: String]
        public let headLength: Int
        public let contentLength: Int
    }

    public enum Failure: Error, Equatable {
        case malformed, tooLarge, chunked
    }

    /// Parses a head at the start of `buffer`; nil while it is still incomplete.
    public static func parseHead(_ buffer: Data) throws -> Head? {
        let end = Data("\r\n\r\n".utf8)
        guard let range = buffer.range(of: end) else {
            if buffer.count > maxHead { throw Failure.tooLarge }
            return nil
        }
        let headLength = range.upperBound - buffer.startIndex
        guard headLength <= maxHead, let text = String(data: buffer[buffer.startIndex..<range.lowerBound], encoding: .isoLatin1) else {
            throw Failure.tooLarge
        }
        var lines = text.components(separatedBy: "\r\n")
        let first = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: true).map(String.init)
        guard first.count >= 3 else { throw Failure.malformed }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            headers[key] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        if headers["transfer-encoding"]?.lowercased().contains("chunked") == true { throw Failure.chunked }
        let length = Int(headers["content-length"] ?? "0") ?? -1
        guard length >= 0 else { throw Failure.malformed }
        guard length <= maxBody else { throw Failure.tooLarge }
        let target = first[1]
        let pathPart = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        var query: [String: String] = [:]
        if pathPart.count == 2 {
            for pair in pathPart[1].split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
                query[decode(kv[0])] = kv.count > 1 ? decode(kv[1]) : ""
            }
        }
        return Head(method: first[0].uppercased(), path: decode(String(pathPart[0])), query: query, headers: headers,
                    headLength: headLength, contentLength: length)
    }

    static func decode(_ s: String) -> String {
        s.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? s
    }

    public static func reason(_ status: Int) -> String {
        switch status {
        case 100: return "Continue"
        case 200: return "OK"
        case 202: return "Accepted"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 409: return "Conflict"
        case 410: return "Gone"
        case 411: return "Length Required"
        case 413: return "Payload Too Large"
        case 429: return "Too Many Requests"
        default: return status >= 500 ? "Server Error" : "Status"
        }
    }
}
