import { listUsageSeries, readUsageSamples } from '../utils/aws/cloudwatchUsage';

describe('repro', () => {
  it('reads emulator', async () => {
    const series = await listUsageSeries({ businessID: 'demo-labs', customerId: 'cus_sandbox01', dimensionId: 'dim_widgets' });
    console.log('SERIES', JSON.stringify(series));
    for (const s of series) {
      const samples = await readUsageSamples({ series: s, startTime: new Date('2024-02-14T00:00:00Z'), endTime: new Date('2024-02-14T03:00:00Z') });
      console.log('SAMPLES', JSON.stringify(samples));
    }
  });
});
