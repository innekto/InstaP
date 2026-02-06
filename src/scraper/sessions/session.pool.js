export class SessionPool {
  constructor(sessions) {
    this.sessions = sessions;
    this.index = 0;
  }

  next() {
    const session = this.sessions[this.index];
    this.index = (this.index + 1) % this.sessions.length;
    return session;
  }
}
