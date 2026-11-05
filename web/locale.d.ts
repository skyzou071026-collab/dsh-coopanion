export type PetLanguage = 'zh' | 'en';
export function petLanguage(locale?: string): PetLanguage;
export function automaticPetLanguage(languages?: readonly string[]): PetLanguage;
export function appStatusBody(notice: { category: string; body: string }, locale?: string): string;
export function appNoticeCopy(notice: { title: string; body: string }, locale?: string): { title: string; body: string };
export function petCopy(locale?: string): { labels: Record<string, string>; issueError: string; [key: string]: unknown };

export function sessionStateLabel(session: { mood?: string; active?: boolean; completion?: string } | undefined, locale?: string, mood?: string): string;
