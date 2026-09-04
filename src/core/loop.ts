/**
 * Fixed-timestep accumulator.
 *
 * Physics runs on a fixed step so that the same inputs from the same state
 * produce the same outcome — the property that makes a physics bug reproducible
 * from a report (SPEC §4.2). Rendering still happens at whatever rate the
 * display manages.
 */
export class FixedLoop {
  private accumulator = 0;

  constructor(
    /** Seconds per simulation step. */
    readonly stepSeconds: number,
    private readonly onStep: (dt: number) => void,
    /**
     * Most steps to run for one frame. Past this the simulation stops trying to
     * catch up, so a stall cannot cascade into a freeze (the spiral of death).
     */
    private readonly maxStepsPerFrame = 5,
  ) {}

  /** Feeds elapsed wall time in and runs whole steps. Returns how many ran. */
  advance(elapsedMs: number): number {
    this.accumulator += Math.max(0, elapsedMs) / 1000;
    let steps = 0;
    while (this.accumulator >= this.stepSeconds && steps < this.maxStepsPerFrame) {
      this.accumulator -= this.stepSeconds;
      this.onStep(this.stepSeconds);
      steps++;
    }
    if (steps === this.maxStepsPerFrame) this.accumulator = 0;
    return steps;
  }

  reset(): void {
    this.accumulator = 0;
  }
}
