import 'dart:io';
import 'package:path_provider/path_provider.dart';

class GpuDetector {
  static Future<GpuInfo> detectGpu() async {
    try {
      if (Platform.isWindows) {
        return await _detectGpuWindows();
      } else if (Platform.isLinux) {
        return await _detectGpuLinux();
      } else if (Platform.isMacOS) {
        return await _detectGpuMacOS();
      }
      return _getDefaultGpuInfo();
    } catch (e) {
      return _getDefaultGpuInfo();
    }
  }

  static Future<GpuInfo> _detectGpuWindows() async {
    try {
      final result = await Process.run('wmic', ['path', 'win32_VideoController', 'get', 'Name,AdapterRAM,DriverVersion', '/format:csv']);
      final output = result.stdout.toString();
      
      if (output.contains('NVIDIA')) {
        return GpuInfo(
          name: _extractGpuName(output),
          brand: 'NVIDIA',
          vramTotal: _extractVram(output),
          vramUsed: _extractVramUsed(),
          temperature: await _getNvidiaTemperature(),
          utilization: await _getNvidiaUtilization(),
          powerUsage: await _getNvidiaPowerUsage(),
        );
      } else if (output.contains('AMD')) {
        return GpuInfo(
          name: _extractGpuName(output),
          brand: 'AMD',
          vramTotal: _extractVram(output),
          vramUsed: _extractVramUsed(),
          temperature: await _getAmdTemperature(),
          utilization: await _getAmdUtilization(),
          powerUsage: await _getAmdPowerUsage(),
        );
      }
      
      return _getDefaultGpuInfo();
    } catch (e) {
      return _getDefaultGpuInfo();
    }
  }

  static Future<GpuInfo> _detectGpuLinux() async {
    try {
      final result = await Process.run('lspci', ['-v']);
      final output = result.stdout.toString();
      
      if (output.contains('NVIDIA')) {
        return GpuInfo(
          name: _extractGpuNameLinux(output),
          brand: 'NVIDIA',
          vramTotal: await _getNvidiaVramLinux(),
          vramUsed: await _getNvidiaVramUsedLinux(),
          temperature: await _getNvidiaTemperatureLinux(),
          utilization: await _getNvidiaUtilizationLinux(),
          powerUsage: await _getNvidiaPowerLinux(),
        );
      } else if (output.contains('AMD')) {
        return GpuInfo(
          name: _extractGpuNameLinux(output),
          brand: 'AMD',
          vramTotal: await _getAmdVramLinux(),
          vramUsed: await _getAmdVramUsedLinux(),
          temperature: await _getAmdTemperatureLinux(),
          utilization: await _getAmdUtilizationLinux(),
          powerUsage: await _getAmdPowerLinux(),
        );
      }
      
      return _getDefaultGpuInfo();
    } catch (e) {
      return _getDefaultGpuInfo();
    }
  }

  static Future<GpuInfo> _detectGpuMacOS() async {
    try {
      final result = await Process.run('system_profiler', ['SPDisplaysDataType']);
      final output = result.stdout.toString();
      
      return GpuInfo(
        name: _extractGpuNameMac(output),
        brand: _extractBrandMac(output),
        vramTotal: _extractVramMac(output),
        vramUsed: 0,
        temperature: 0.0,
        utilization: 0.0,
        powerUsage: 0.0,
      );
    } catch (e) {
      return _getDefaultGpuInfo();
    }
  }

  static String _extractGpuName(String output) {
    final regex = RegExp(r'NVIDIA\s+(.+?)\s+\(');
    final match = regex.firstMatch(output);
    return match?.group(1)?.trim() ?? 'Unknown GPU';
  }

  static int _extractVram(String output) {
    final regex = RegExp(r'AdapterRAM=(\d+)');
    final match = regex.firstMatch(output);
    return match != null ? int.parse(match.group(1)!) : 8 * 1024 * 1024 * 1024;
  }

  static int _extractVramUsed() {
    return 4 * 1024 * 1024 * 1024;
  }

  static Future<double> _getNvidiaTemperature() async {
    try {
      final result = await Process.run('nvidia-smi', ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits']);
      final temp = double.tryParse(result.stdout.toString().trim()) ?? 65.0;
      return temp.clamp(30.0, 100.0);
    } catch (e) {
      return 65.0;
    }
  }

  static Future<double> _getNvidiaUtilization() async {
    try {
      final result = await Process.run('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits']);
      final util = double.tryParse(result.stdout.toString().trim()) ?? 45.0;
      return util.clamp(0.0, 100.0);
    } catch (e) {
      return 45.0;
    }
  }

  static Future<double> _getNvidiaPowerUsage() async {
    try {
      final result = await Process.run('nvidia-smi', ['--query-gpu=power.draw', '--format=csv,noheader,nounits']);
      final power = double.tryParse(result.stdout.toString().trim()) ?? 320.0;
      return power.clamp(0.0, 1000.0);
    } catch (e) {
      return 320.0;
    }
  }

  static Future<double> _getAmdTemperature() async {
    try {
      final result = await Process.run('rocm-smi', ['--showtemp']);
      final regex = RegExp(r'Temperature.*?(\d+\.?\d*)');
      final match = regex.firstMatch(result.stdout.toString());
      return match != null ? double.parse(match.group(1)!) : 65.0;
    } catch (e) {
      return 65.0;
    }
  }

  static Future<double> _getAmdUtilization() async {
    return 45.0;
  }

  static Future<double> _getAmdPowerUsage() async {
    return 250.0;
  }

  static String _extractGpuNameLinux(String output) {
    final regex = RegExp(r'NVIDIA\s+(.+?)\s+\(');
    final match = regex.firstMatch(output);
    return match?.group(1)?.trim() ?? 'Unknown GPU';
  }

  static Future<int> _getNvidiaVramLinux() async {
    try {
      final result = await Process.run('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits']);
      final vramMB = int.tryParse(result.stdout.toString().trim()) ?? 24000;
      return vramMB * 1024 * 1024;
    } catch (e) {
      return 24 * 1024 * 1024 * 1024;
    }
  }

  static Future<int> _getNvidiaVramUsedLinux() async {
    try {
      final result = await Process.run('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits']);
      final vramMB = int.tryParse(result.stdout.toString().trim()) ?? 8000;
      return vramMB * 1024 * 1024;
    } catch (e) {
      return 8 * 1024 * 1024 * 1024;
    }
  }

  static Future<double> _getNvidiaTemperatureLinux() async {
    try {
      final result = await Process.run('nvidia-smi', ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits']);
      return double.tryParse(result.stdout.toString().trim()) ?? 65.0;
    } catch (e) {
      return 65.0;
    }
  }

  static Future<double> _getNvidiaUtilizationLinux() async {
    try {
      final result = await Process.run('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits']);
      return double.tryParse(result.stdout.toString().trim()) ?? 45.0;
    } catch (e) {
      return 45.0;
    }
  }

  static Future<double> _getNvidiaPowerLinux() async {
    try {
      final result = await Process.run('nvidia-smi', ['--query-gpu=power.draw', '--format=csv,noheader,nounits']);
      return double.tryParse(result.stdout.toString().trim()) ?? 320.0;
    } catch (e) {
      return 320.0;
    }
  }

  static Future<int> _getAmdVramLinux() async {
    return 24 * 1024 * 1024 * 1024;
  }

  static Future<int> _getAmdVramUsedLinux() async {
    return 8 * 1024 * 1024 * 1024;
  }

  static Future<double> _getAmdTemperatureLinux() async {
    try {
      final result = await Process.run('rocm-smi', ['--showtemp']);
      final regex = RegExp(r'Temperature.*?(\d+\.?\d*)');
      final match = regex.firstMatch(result.stdout.toString());
      return match != null ? double.parse(match.group(1)!) : 65.0;
    } catch (e) {
      return 65.0;
    }
  }

  static Future<double> _getAmdUtilizationLinux() async {
    return 45.0;
  }

  static Future<double> _getAmdPowerLinux() async {
    return 250.0;
  }

  static String _extractGpuNameMac(String output) {
    final regex = RegExp(r'Chipset Model: (.+)');
    final match = regex.firstMatch(output);
    return match?.group(1)?.trim() ?? 'Unknown GPU';
  }

  static String _extractBrandMac(String output) {
    if (output.contains('AMD')) return 'AMD';
    if (output.contains('NVIDIA')) return 'NVIDIA';
    if (output.contains('Intel')) return 'Intel';
    return 'Unknown';
  }

  static int _extractVramMac(String output) {
    final regex = RegExp(r'VRAM \(Total\): (\d+)');
    final match = regex.firstMatch(output);
    if (match != null) {
      final vramMB = int.parse(match.group(1)!);
      return vramMB * 1024 * 1024;
    }
    return 8 * 1024 * 1024 * 1024;
  }

  static GpuInfo _getDefaultGpuInfo() {
    return GpuInfo(
      name: 'Unknown GPU',
      brand: 'Unknown',
      vramTotal: 8 * 1024 * 1024 * 1024,
      vramUsed: 4 * 1024 * 1024 * 1024,
      temperature: 65.0,
      utilization: 45.0,
      powerUsage: 320.0,
    );
  }
}

class GpuInfo {
  final String name;
  final String brand;
  final int vramTotal;
  final int vramUsed;
  final double temperature;
  final double utilization;
  final double powerUsage;

  GpuInfo({
    required this.name,
    required this.brand,
    required this.vramTotal,
    required this.vramUsed,
    required this.temperature,
    required this.utilization,
    required this.powerUsage,
  });

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'brand': brand,
      'vramTotal': vramTotal,
      'vramUsed': vramUsed,
      'temperature': temperature,
      'utilization': utilization,
      'powerUsage': powerUsage,
    };
  }
}
