import test from 'node:test';
import assert from 'node:assert/strict';
import { rendererCpuTracker, rendererCpuLimits } from '../src/renderer-cpu';

test('la página musical con la CPU ocupada se registra al empezar, cada minuto y al volver a reposo', () => {
  const logs: Array<[string, Record<string, number>]> = [];
  const track = rendererCpuTracker((event, fields) => logs.push([event, fields]));
  // Picos sueltos no abren episodio.
  track({ cpu: 95, memoryMB: 600 }); track({ cpu: 10, memoryMB: 600 }); track({ cpu: 99, memoryMB: 600 }); track({ cpu: 90, memoryMB: 600 }); track(undefined);
  track({ cpu: 5, memoryMB: 600 }); assert.equal(logs.length, 0);
  // Tres lecturas seguidas de 60 % o más (15 s) abren el episodio.
  track({ cpu: 97, memoryMB: 660 }); track({ cpu: 99, memoryMB: 662 }); track({ cpu: 98, memoryMB: 664.4 });
  assert.deepEqual(logs, [['Rendimiento: página musical con la CPU ocupada', { cpuPromedio: 98, cpuMaximo: 99, segundos: 15, memoriaMB: 664 }]]);
  for (let i = 0; i < rendererCpuLimits.reportEverySamples; i++) track({ cpu: 100, memoryMB: 670 });
  assert.equal(logs.length, 2); assert.equal(logs[1][0], 'Rendimiento: página musical sigue con la CPU ocupada'); assert.equal(logs[1][1].segundos, 75);
  track({ cpu: 3, memoryMB: 670 });
  assert.equal(logs.length, 3); assert.equal(logs[2][0], 'Rendimiento: página musical vuelve a reposo'); assert.equal(logs[2][1].cpuAhora, 3);
  // Después de reposar, hace falta otro arranque de tres lecturas.
  track({ cpu: 99, memoryMB: 600 }); track({ cpu: 99, memoryMB: 600 }); assert.equal(logs.length, 3);
});
