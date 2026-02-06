export class Limiter {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
  }

  async run(task) {
    if (this.active >= this.concurrency) {
      await new Promise((resolve) => this.queue.push(resolve));
    }

    this.active++;

    try {
      return await task();
    } finally {
      this.active--;
      if (this.queue.length) this.queue.shift()();
    }
  }
}
