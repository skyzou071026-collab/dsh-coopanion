import { applyGoalProjection, goalProjectionDefinition, type GoalProjectionState } from '@deepseek-ai/dsh-goal';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { TaskNotice } from './notification-contract.ts';

export interface CompletionDecision {
  category: 'reply' | 'goal-progress' | 'completed' | 'blocked' | 'stopped';
  mood: 'idle' | 'happy' | 'waiting';
  text: string;
  silent?: boolean;
  clear?: boolean;
  goal?: NonNullable<TaskNotice['goal']>;
}
const reply: CompletionDecision = { category: 'reply', mood: 'idle', text: '本轮回复已生成，回到会话查看。' };

/** Strict public goal replay, shared by character state and both reminder channels.
 * No tool arguments/results are interpreted as a committed goal mutation.
 */
export class CompletionTracker {
  private state: GoalProjectionState = goalProjectionDefinition.init();
  private turn = 0;
  private open = false;
  private ended = -1;
  private startSeq = -1;
  private completeSeq = -1;
  private announced = '';

  consume(event: SessionEvent): CompletionDecision | undefined {
    if (event.type === 'goal/change' || event.type === 'user/message' && event.data.source.kind === 'goal') {
      this.state = applyGoalProjection(this.state, event);
      if (event.type === 'goal/change' && !this.state.failure) {
        if (event.data.operation === 'complete') this.completeSeq = event.seq;
        // The round driver may commit a blocker after turn/end (e.g. exhausted budget).
        if (!this.open || event.data.operation === 'clear') {
          if (['complete', 'block', 'pause'].includes(event.data.operation)) return this.decision(event.seq);
          if (event.data.operation === 'clear') return { ...reply, text: '准备好了，随时叫我。', silent: true, clear: true };
          return { ...this.decision(event.seq), text: '目标状态已更新，回到会话查看。', silent: true };
        }
      }
    }
    if (event.type === 'turn/start' && event.data.turn > this.turn && event.data.turn > this.ended) {
      this.turn = event.data.turn; this.open = true; this.startSeq = event.seq;
    }
    if (event.type !== 'turn/end' || event.data.turn < this.turn || event.data.turn <= this.ended) return;
    this.turn = event.data.turn; this.ended = event.data.turn;
    this.open = false;
    if (event.data.reason.kind !== 'completed') return;
    return this.decision(event.seq);
  }

  private decision(seq: number): CompletionDecision {
    // A malformed or unsupported owned stream permanently loses success authority.
    const current = this.state.failure ? null : this.state.current;
    if (!current) return { ...reply };
    const goal = { id: current.goal.id, revision: current.goal.revision, round: current.roundsStarted };
    if (current.goal.phase === 'active') return { category: 'goal-progress', mood: 'idle', text: '本轮回复已生成，目标仍在进行中。', goal };
    if (current.goal.phase === 'paused') return { category: 'stopped', mood: 'idle', text: '目标已暂停，回到会话查看。', goal };
    if (current.goal.phase === 'blocked') return { category: 'blocked', mood: 'waiting', text: '目标遇到阻碍，回到会话查看。', goal };
    const identity = JSON.stringify([goal.id, goal.revision]);
    if (this.completeSeq >= this.startSeq && this.completeSeq <= seq && this.announced !== identity) {
      this.announced = identity;
      return { category: 'completed', mood: 'happy', text: '目标已完成，回到会话查看。', goal };
    }
    // A previous goal's success cannot turn a later ordinary reply into goal completion.
    return { ...reply };
  }
}
