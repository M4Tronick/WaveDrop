// WaveDrop Bluetooth LE helper (Windows).
// Advertises a small WaveDrop beacon and reports beacons from nearby PCs.
// Protocol on stdin:  "advertise <hex>" | "unadvertise" | "scan on" | "scan off" | "quit"
// Protocol on stdout: "status ..." | "seen <bt-address> <rssi> <hex>"
// Build: see scripts/build-ble-helper.ps1 (C# 5, .NET Framework 4.x csc).
using System;
using System.Linq;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;

class BleHelper
{
    const ushort CompanyId = 0xFFFF; // Bluetooth SIG id reserved for testing / unassigned use
    static BluetoothLEAdvertisementPublisher publisher;
    static BluetoothLEAdvertisementWatcher watcher;
    static readonly object outLock = new object();

    static void Emit(string line)
    {
        lock (outLock)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    static string Clean(string s) { return (s ?? "").Replace('\r', ' ').Replace('\n', ' '); }

    static int Main()
    {
        try
        {
            BluetoothAdapter adapter = BluetoothAdapter.GetDefaultAsync().AsTask().Result;
            if (adapter == null || !adapter.IsLowEnergySupported)
            {
                Emit("status unsupported");
                return 2;
            }
            Emit("status ready peripheral=" + (adapter.IsPeripheralRoleSupported ? 1 : 0) +
                 " central=" + (adapter.IsCentralRoleSupported ? 1 : 0));
        }
        catch (Exception e)
        {
            Emit("status error " + Clean(e.Message));
            return 3;
        }

        watcher = new BluetoothLEAdvertisementWatcher();
        watcher.ScanningMode = BluetoothLEScanningMode.Passive;
        BluetoothLEManufacturerData filter = new BluetoothLEManufacturerData();
        filter.CompanyId = CompanyId;
        watcher.AdvertisementFilter.Advertisement.ManufacturerData.Add(filter);
        watcher.Received += (s, a) =>
        {
            foreach (BluetoothLEManufacturerData m in a.Advertisement.GetManufacturerDataByCompanyId(CompanyId))
            {
                byte[] bytes = m.Data.ToArray();
                if (bytes.Length >= 2 && bytes[0] == 0x57 && bytes[1] == 0x44) // "WD"
                {
                    Emit("seen " + a.BluetoothAddress.ToString("X12") + " " + a.RawSignalStrengthInDBm + " " +
                         BitConverter.ToString(bytes).Replace("-", ""));
                }
            }
        };
        watcher.Stopped += (s, a) => Emit("status scan-stopped " + a.Error);

        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            string[] parts = line.Trim().Split(' ');
            try
            {
                switch (parts[0])
                {
                    case "advertise": Advertise(parts[1]); break;
                    case "unadvertise": StopAdvertising(); break;
                    case "scan":
                        if (parts[1] == "on") watcher.Start(); else watcher.Stop();
                        Emit("status scan " + watcher.Status);
                        break;
                    case "quit":
                        StopAdvertising();
                        watcher.Stop();
                        return 0;
                }
            }
            catch (Exception e)
            {
                Emit("status error " + Clean(e.Message));
            }
        }
        // stdin closed: the app went away.
        StopAdvertising();
        watcher.Stop();
        return 0;
    }

    static void Advertise(string hex)
    {
        StopAdvertising();
        byte[] data = Enumerable.Range(0, hex.Length / 2).Select(i => Convert.ToByte(hex.Substring(i * 2, 2), 16)).ToArray();
        publisher = new BluetoothLEAdvertisementPublisher();
        BluetoothLEManufacturerData md = new BluetoothLEManufacturerData();
        md.CompanyId = CompanyId;
        md.Data = data.AsBuffer();
        publisher.Advertisement.ManufacturerData.Add(md);
        publisher.StatusChanged += (s, a) => Emit("status advertise " + a.Status + " " + a.Error);
        publisher.Start();
    }

    static void StopAdvertising()
    {
        if (publisher == null) return;
        publisher.Stop();
        publisher = null;
    }
}
