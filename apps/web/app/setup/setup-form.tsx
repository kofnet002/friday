'use client';

import { Briefcase, FileText, FolderKanban, History, Sparkles, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { AnswerProvider, InterviewType } from '@friday/shared-types';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  fetchContext,
  fetchLatestSession,
  forkSession,
  getOrCreateSessionId,
  onSessionIdChange,
  saveContext,
  setProviderPreference,
  setSessionId,
  uploadResume,
} from '@/lib/session-context';
import { cn } from '@/lib/utils';

import { ProjectsLibrary } from './projects-section';
import { SessionsList } from './sessions-section';

export function SetupForm({ onComplete }: { onComplete?: () => void } = {}) {
  const router = useRouter();
  const [sessionId, setSid] = useState<string>('');
  const [jobTitle, setJobTitle] = useState('');
  const [company, setCompany] = useState('');
  const [language, setLanguage] = useState('en');
  const [extraInstructions, setExtra] = useState('');
  const [interviewType, setInterviewType] = useState<InterviewType>('mixed');
  const [defaultProvider, setDefaultProvider] = useState<AnswerProvider>('gemini');
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeStatus, setResumeStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'uploading' }
    | { kind: 'ok'; chars: number }
    | { kind: 'err'; msg: string }
  >({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  const [hasPriorSession, setHasPriorSession] = useState(false);
  const [switching, setSwitching] = useState(false);
  // One-line confirmation after starting or switching sessions.
  const [notice, setNotice] = useState<string | null>(null);
  const [sessionsRefresh, setSessionsRefresh] = useState(0);

  // Fill the form from a saved session. An unsaved id keeps what's typed.
  const loadSession = (id: string) => {
    setResumeFile(null);
    setResumeStatus({ kind: 'idle' });
    fetchContext(id).then((ctx) => {
      if (!ctx || !ctx.exists) return;
      setJobTitle(ctx.job_title ?? '');
      setCompany(ctx.company ?? '');
      setLanguage(ctx.language ?? 'en');
      setExtra(ctx.extra_instructions ?? '');
      if (ctx.interview_type) setInterviewType(ctx.interview_type);
      const p = ctx.default_provider;
      if (p === 'gemini' || p === 'openai' || p === 'deepseek' || p === 'claude') {
        setDefaultProvider(p);
      }
      if (ctx.resume_chars) setResumeStatus({ kind: 'ok', chars: ctx.resume_chars });
    });
  };

  useEffect(() => {
    const id = getOrCreateSessionId();
    setSid(id);
    loadSession(id);
    fetchLatestSession().then((latest) => {
      if (latest && latest.session_id !== id) setHasPriorSession(true);
    });
    // Follow switches made elsewhere (and our own, via setSessionId).
    return onSessionIdChange((next) => {
      setSid(next);
      loadSession(next);
      setSessionsRefresh((n) => n + 1);
    });
  }, []);

  const duplicateLastSession = async () => {
    const latest = await fetchLatestSession();
    if (!latest) return;
    if (latest.job_title) setJobTitle(latest.job_title);
    if (latest.company) setCompany(latest.company);
    if (latest.language) setLanguage(latest.language);
    if (latest.extra_instructions) setExtra(latest.extra_instructions);
    if (latest.interview_type) setInterviewType(latest.interview_type);
    if (
      latest.default_provider === 'gemini' ||
      latest.default_provider === 'openai' ||
      latest.default_provider === 'deepseek' ||
      latest.default_provider === 'claude'
    ) {
      setDefaultProvider(latest.default_provider);
    }
  };

  // A new session keeps this one's setup (role, resume, projects) and starts
  // fresh history, spend and audio budget. Nothing saved yet → plain new id.
  const regenerateSession = async () => {
    setSwitching(true);
    const forked = sessionId ? await forkSession(sessionId) : null;
    const id = forked ?? crypto.randomUUID();
    setSessionId(id);
    setSwitching(false);
    setNotice(
      forked
        ? `New session ${id.slice(0, 8)} started. Role, resume and projects carried over; history, spend and audio start from zero.`
        : `New session ${id.slice(0, 8)}. Fill in the context and start it.`,
    );
  };

  const switchToSession = (id: string) => {
    setSessionId(id);
    setNotice(`Switched to session ${id.slice(0, 8)}.`);
  };

  const handleResumeChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setResumeFile(file);
    setResumeStatus({ kind: 'uploading' });
    const result = await uploadResume(sessionId, file);
    if (result.ok) {
      setResumeStatus({ kind: 'ok', chars: result.chars ?? 0 });
    } else {
      setResumeStatus({ kind: 'err', msg: result.error ?? 'upload failed' });
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const ok = await saveContext({
      session_id: sessionId,
      job_title: jobTitle || undefined,
      company: company || undefined,
      language,
      extra_instructions: extraInstructions || undefined,
      interview_type: interviewType,
      default_provider: defaultProvider,
    });
    setProviderPreference(defaultProvider);
    setSaving(false);
    if (ok) {
      if (onComplete) onComplete();
      else router.push('/session');
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-7">
      <Section
        icon={<Briefcase className="h-3.5 w-3.5" aria-hidden />}
        title="Role context"
        description="Grounds the copilot's answers in the role you're interviewing for."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Labeled label="Job title">
            <Input
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="e.g. Staff Engineer"
            />
          </Labeled>
          <Labeled label="Company">
            <Input
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="e.g. Anthropic"
            />
          </Labeled>
        </div>
        <Labeled label="Interview type">
          <Select
            value={interviewType}
            onChange={(e) => setInterviewType(e.target.value as InterviewType)}
          >
            <option value="technical">Technical</option>
            <option value="behavioral">Behavioral</option>
            <option value="system_design">System design</option>
            <option value="mixed">Mixed</option>
          </Select>
        </Labeled>
      </Section>

      <Section
        icon={<Sparkles className="h-3.5 w-3.5" aria-hidden />}
        title="Output preferences"
        description="How the copilot should respond when you ask."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Labeled label="Default copilot model">
            <Select
              value={defaultProvider}
              onChange={(e) => setDefaultProvider(e.target.value as AnswerProvider)}
            >
              <option value="gemini">Gemini 2.5 Pro</option>
              <option value="openai">GPT-4o</option>
              <option value="deepseek">DeepSeek</option>
              <option value="claude">Claude</option>
            </Select>
          </Labeled>
          <Labeled label="Language">
            <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="pt">Portuguese</option>
              <option value="zh">Chinese</option>
              <option value="ja">Japanese</option>
            </Select>
          </Labeled>
        </div>
        <Labeled label="Extra instructions (optional)">
          <Textarea
            value={extraInstructions}
            onChange={(e) => setExtra(e.target.value)}
            placeholder="e.g. keep answers under 90 seconds, always include tradeoffs, I prefer Python over Go"
          />
        </Labeled>
      </Section>

      <Section
        icon={<FileText className="h-3.5 w-3.5" aria-hidden />}
        title="Resume"
        description="PDF or DOCX, optional. Stays on your machine — extracted text lives in local SQLite."
      >
        <ResumeUploadField
          status={resumeStatus}
          fileName={resumeFile?.name}
          onChange={handleResumeChange}
        />
      </Section>

      <Section
        icon={<FolderKanban className="h-3.5 w-3.5" aria-hidden />}
        title="Projects"
        description="Repos and PRs you may be asked about. Attached projects' briefs ground live answers."
      >
        <ProjectsLibrary sessionId={sessionId} />
      </Section>

      <Section
        icon={<History className="h-3.5 w-3.5" aria-hidden />}
        title="Sessions"
        description="Each session has its own history, spend and audio budget. Switch to reuse one, or start a new session below."
      >
        <SessionsList
          sessionId={sessionId}
          refreshKey={sessionsRefresh}
          onSwitch={switchToSession}
        />
      </Section>

      {notice ? (
        <p
          role="status"
          className="rounded-md border border-emerald-400/50 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          {notice}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 border-t border-neutral-200 pt-5 sm:flex-row sm:items-center sm:justify-between dark:border-neutral-800">
        <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 font-mono text-[11px] dark:bg-neutral-800">
            session {sessionId.slice(0, 8)}
          </span>
          <button
            type="button"
            onClick={() => void regenerateSession()}
            disabled={switching}
            className="underline-offset-2 hover:text-neutral-800 hover:underline disabled:opacity-50 dark:hover:text-neutral-200"
          >
            {switching ? 'starting…' : 'new session'}
          </button>
          {hasPriorSession ? (
            <button
              type="button"
              onClick={duplicateLastSession}
              className="underline-offset-2 hover:text-neutral-800 hover:underline dark:hover:text-neutral-200"
            >
              duplicate last
            </button>
          ) : null}
        </div>
        <Button type="submit" disabled={saving} size="lg">
          {saving ? 'Saving…' : 'Start session →'}
        </Button>
      </div>
    </form>
  );
}

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-600 dark:text-sky-400">
          {icon}
          {title}
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{description}</p>
      </header>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

function ResumeUploadField({
  status,
  fileName,
  onChange,
}: {
  status:
    | { kind: 'idle' }
    | { kind: 'uploading' }
    | { kind: 'ok'; chars: number }
    | { kind: 'err'; msg: string };
  fileName?: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <label
      className={cn(
        'group relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-7 text-center transition-colors',
        status.kind === 'ok'
          ? 'border-emerald-400/60 bg-emerald-50/40 dark:border-emerald-400/30 dark:bg-emerald-950/20'
          : status.kind === 'err'
            ? 'border-red-400/60 bg-red-50/40 dark:border-red-400/30 dark:bg-red-950/20'
            : 'border-neutral-300 hover:border-sky-400 hover:bg-sky-50/40 dark:border-neutral-700 dark:hover:border-sky-400 dark:hover:bg-sky-950/20',
      )}
    >
      <input
        type="file"
        accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        onChange={onChange}
        className="sr-only"
      />
      <Upload
        className={cn(
          'h-5 w-5 transition-colors',
          status.kind === 'ok'
            ? 'text-emerald-600 dark:text-emerald-400'
            : status.kind === 'err'
              ? 'text-red-600 dark:text-red-400'
              : 'text-neutral-400 group-hover:text-sky-500 dark:text-neutral-500',
        )}
        aria-hidden
      />
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
          {status.kind === 'ok'
            ? `Parsed ${status.chars.toLocaleString()} characters`
            : status.kind === 'uploading'
              ? `Uploading ${fileName ?? 'file'}…`
              : status.kind === 'err'
                ? 'Upload failed'
                : 'Drop your resume or click to upload'}
        </p>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {status.kind === 'err'
            ? status.msg
            : fileName && status.kind !== 'idle'
              ? fileName
              : 'PDF or DOCX'}
        </p>
      </div>
    </label>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        {label}
      </span>
      {children}
    </label>
  );
}
