export interface QueueTask {
  run: () => Promise<void>;
}

export interface QueueOptions {
  maxDepth: number;
  dropOldestOnOverflow: boolean;
}

type PendingTask = {
  task: QueueTask;
  resolve: () => void;
  reject: (err: unknown) => void;
};

export class SerialQueue {
  private queue: PendingTask[] = [];
  private running = false;

  constructor(private readonly options: QueueOptions, private readonly onOverflow: (dropped: number) => void = () => {}) {}

  enqueue(task: QueueTask): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= this.options.maxDepth) {
        if (this.options.dropOldestOnOverflow) {
          this.queue.shift();
          this.onOverflow(1);
        } else {
          reject(new Error('queue_full'));
          return;
        }
      }
      this.queue.push({ task, resolve, reject });
      void this.process().catch(() => {});
    });
  }

  isRunning() {
    return this.running;
  }

  private async process() {
    if (this.running) return;
    this.running = true;

    while (this.queue.length) {
      const item = this.queue.shift();
      if (!item) continue;
      try {
        await item.task.run();
        item.resolve();
      } catch (err) {
        item.reject(err);
      }
    }

    this.running = false;
  }

  size() {
    return this.queue.length;
  }

  clear() {
    this.queue.length = 0;
  }
}
