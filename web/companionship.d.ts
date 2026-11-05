export type CompanionshipMode = 'off' | 'quiet' | 'interactive';
export const COMPANIONSHIP_MODES: CompanionshipMode[];
export function companionshipMode(value: unknown): CompanionshipMode;
export interface CompanionState {
  mode: CompanionshipMode; period: 'day' | 'night' | null; lastAt: number | null; inviteAt: number | null;
  invitation: 'pending' | 'shown' | null; invitationUntil: number | null;
  active: { kind: string; steps: [string, number][]; index: number; dueAt: number; manual: boolean; deadline: number } | null;
  blocked: boolean;
}
export function initialCompanionship(): CompanionState;
export function stepCompanionship(state: CompanionState, input: { mode: unknown; now: number; hour: number; words?: string[]; occupied?: boolean; automatic?: boolean; eligible?: boolean; motionBusy?: boolean; unlocked?: boolean; action?: string }, random?: () => number): { state: CompanionState; release?: boolean; word?: string; hideInvitation?: boolean; showInvitation?: boolean; reserveInvitation?: boolean; completed?: boolean };
