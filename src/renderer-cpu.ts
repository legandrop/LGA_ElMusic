import type { WebContents } from 'electron';

// Vigía de CPU del proceso de la página musical (tras un Shuffle, con la app
// quieta, su renderer siguió a un núcleo entero durante minutos, sin tareas largas que lo delataran). Cada 5 s main lee el
// uso de CPU de ese proceso con app.getAppMetrics (API pública de Electron, sólo números). Tres lecturas seguidas de 60 %
// o más abren un episodio: se registra al empezar, cada minuto mientras dura y al terminar (hasta 100 líneas por sesión).
export const rendererCpuLimits = { everyMs: 5000, busyPercent: 60, startSamples: 3, reportEverySamples: 12, maxReports: 100 } as const;
export interface CpuSample { cpu: number; memoryMB: number }
type Log = (event: string, fields: Record<string, number>) => void;

export function rendererCpuTracker(log: Log): (sample: CpuSample | undefined) => void {
  let busy = 0, total = 0, peak = 0, reports = 0, open = false, sinceReport = 0;
  const round = (value: number): number => Math.round(value);
  const report = (event: string, fields: Record<string, number>): void => { if (reports++ < rendererCpuLimits.maxReports) log(event, fields); };
  const summary = (): Record<string, number> => ({ cpuPromedio: round(total / busy), cpuMaximo: round(peak), segundos: busy * rendererCpuLimits.everyMs / 1000 });
  return sample => {
    if (!sample || !Number.isFinite(sample.cpu)) return;
    if (sample.cpu >= rendererCpuLimits.busyPercent) {
      busy++; total += sample.cpu; peak = Math.max(peak, sample.cpu); sinceReport++;
      if (!open && busy >= rendererCpuLimits.startSamples) { open = true; sinceReport = 0; report('Rendimiento: página musical con la CPU ocupada', { ...summary(), memoriaMB: round(sample.memoryMB) }); }
      else if (open && sinceReport >= rendererCpuLimits.reportEverySamples) { sinceReport = 0; report('Rendimiento: página musical sigue con la CPU ocupada', { ...summary(), memoriaMB: round(sample.memoryMB) }); }
      return;
    }
    if (open) report('Rendimiento: página musical vuelve a reposo', { ...summary(), cpuAhora: round(sample.cpu) });
    busy = 0; total = 0; peak = 0; open = false; sinceReport = 0;
  };
}

export function installRendererCpuWatch(contents: WebContents, metrics: () => Electron.ProcessMetric[], log: Log): void {
  const track = rendererCpuTracker(log);
  const timer = setInterval(() => {
    if (contents.isDestroyed()) return;
    const pid = contents.getOSProcessId(), metric = metrics().find(item => item.pid === pid);
    track(metric ? { cpu: metric.cpu.percentCPUUsage, memoryMB: (metric.memory?.workingSetSize ?? 0) / 1024 } : undefined);
  }, rendererCpuLimits.everyMs);
  contents.once('destroyed', () => clearInterval(timer));
}
