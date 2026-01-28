import { ResearchProgress } from './deep-research.js';

export class OutputManager {
  private progressLines: number = 4;
  private progressArea: string[] = [];
  private initialized: boolean = false;

  constructor() {
    // Initialize terminal using stderr only for TTYs
    if (process.stderr.isTTY) {
      process.stderr.write('\n'.repeat(this.progressLines));
      this.initialized = true;
    }
  }

  log(...args: any[]) {
    // Move cursor up to progress area
    if (this.initialized) {
      process.stderr.write(`\x1B[${this.progressLines}A`);
      // Clear progress area
      process.stderr.write('\x1B[0J');
    }
    // Print log message to stderr
    console.error(...args);
    // Redraw progress area if initialized
    if (this.initialized) {
      this.drawProgress();
    }
  }

  updateProgress(progress: ResearchProgress) {
    const depthTotal = Math.max(progress.totalDepth, 0);
    const depthCompleted = Math.max(depthTotal - progress.currentDepth, 0);
    const depthPercent = depthTotal > 0 ? Math.round((depthCompleted / depthTotal) * 100) : 0;
    const breadthTotal = Math.max(progress.totalBreadth, 0);
    const breadthCompleted = Math.max(breadthTotal - progress.currentBreadth, 0);
    const breadthPercent = breadthTotal > 0 ? Math.round((breadthCompleted / breadthTotal) * 100) : 0;
    const queriesTotal = Math.max(progress.totalQueries, 0);
    const queriesCompleted = Math.max(progress.completedQueries, 0);
    const queriesPercent = queriesTotal > 0 ? Math.round((queriesCompleted / queriesTotal) * 100) : 0;
    this.progressArea = [
      `Depth:    [${this.getProgressBar(depthCompleted, depthTotal)}] ${depthPercent}%`,
      `Breadth:  [${this.getProgressBar(breadthCompleted, breadthTotal)}] ${breadthPercent}%`,
      `Queries:  [${this.getProgressBar(queriesCompleted, queriesTotal)}] ${queriesPercent}%`,
      progress.currentQuery ? `Current:  ${progress.currentQuery}` : '',
    ];
    this.drawProgress();
  }

  finish() {
    // Stop progress rendering and move cursor below the progress area
    if (this.initialized) {
      this.initialized = false;
      process.stderr.write('\n');
    }
  }

  private getProgressBar(value: number, total: number): string {
    const width = process.stderr.columns
      ? Math.min(30, process.stderr.columns - 20)
      : 30;
    if (total <= 0) {
      return ' '.repeat(width);
    }
    const filled = Math.round((width * value) / total);
    return '█'.repeat(filled) + ' '.repeat(width - filled);
  }

  private drawProgress() {
    if (!this.initialized || this.progressArea.length === 0) return;

    // Move cursor to progress area
    const terminalHeight = process.stderr.rows || 24;
    process.stderr.write(`\x1B[${terminalHeight - this.progressLines};1H`);

    // Draw each line of the progress area
    for (const line of this.progressArea) {
      process.stderr.write(line + '\n');
    }
  }
}
