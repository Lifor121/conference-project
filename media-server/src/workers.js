const os = require('node:os');
const mediasoup = require('mediasoup');
const config = require('./config');

class WorkerPool {
  constructor() {
    this.workers = [];
    this.nextIdx = 0;
  }

  async start() {
    // рекомендация mediasoup: один worker на ядро, но > 4 для фазы 1 ни к чему
    const num = Math.min(os.cpus().length, 4);
    for (let i = 0; i < num; i++) {
      const worker = await mediasoup.createWorker({
        logLevel: config.mediasoup.worker.logLevel,
        logTags: config.mediasoup.worker.logTags,
        rtcMinPort: config.mediasoup.worker.rtcMinPort,
        rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
      });

      // воркер умер — умираем сами, docker (restart: unless-stopped) поднимет
      worker.on('died', () => {
        console.error(`[mediasoup] worker pid=${worker.pid} died — завершаем процесс`);
        setTimeout(() => process.exit(1), 500);
      });

      this.workers.push(worker);
      console.log(`[mediasoup] worker pid=${worker.pid} запущен (${i + 1}/${num})`);
    }
  }

  // роутеры комнат распределяем по воркерам round-robin
  next() {
    const worker = this.workers[this.nextIdx];
    this.nextIdx = (this.nextIdx + 1) % this.workers.length;
    return worker;
  }

  get size() {
    return this.workers.length;
  }
}

const workerPool = new WorkerPool();

module.exports = { workerPool };
