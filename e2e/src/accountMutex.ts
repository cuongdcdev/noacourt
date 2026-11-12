export class AccountMutex {
  private tails = new Map<string, Promise<void>>();

  async run<T>(account: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(account) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(account, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(account) === current) this.tails.delete(account);
    }
  }
}
