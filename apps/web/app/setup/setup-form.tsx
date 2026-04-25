'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { AnswerProvider, InterviewType } from '@friday/shared-types';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  fetchContext,
  fetchLatestSession,
  getOrCreateSessionId,
  saveContext,
  setProviderPreference,
  setSessionId,
  uploadResume,
} from '@/lib/session-context';
import { cn } from '@/lib/utils';

export function SetupForm() {
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

  useEffect(() => {
    const id = getOrCreateSessionId();
    setSid(id);
    fetchContext(id).then((ctx) => {
      if (!ctx || !ctx.exists) return;
      if (ctx.job_title) setJobTitle(ctx.job_title);
      if (ctx.company) setCompany(ctx.company);
      if (ctx.language) setLanguage(ctx.language);
      if (ctx.extra_instructions) setExtra(ctx.extra_instructions);
      if (ctx.resume_chars) {
        setResumeStatus({ kind: 'ok', chars: ctx.resume_chars });
      }
    });
    fetchLatestSession().then((latest) => {
      if (latest && latest.session_id !== id) setHasPriorSession(true);
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
    if (latest.default_provider === 'gemini' || latest.default_provider === 'openai') {
      setDefaultProvider(latest.default_provider);
    }
  };

  const regenerateSession = () => {
    const id = crypto.randomUUID();
    setSessionId(id);
    setSid(id);
    setResumeStatus({ kind: 'idle' });
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
      router.push('/session');
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Labeled label="Job title">
          <input
            className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-neutral-400 dark:border-neutral-700 dark:bg-neutral-950"
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
            placeholder="e.g. Staff Engineer"
          />
        </Labeled>
        <Labeled label="Company">
          <input
            className="h-10 rounded-md border border-neutral-300 bg-white px-3 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-neutral-400 dark:border-neutral-700 dark:bg-neutral-950"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="e.g. Anthropic"
          />
        </Labeled>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
        <Labeled label="Default copilot model">
          <Select
            value={defaultProvider}
            onChange={(e) => setDefaultProvider(e.target.value as AnswerProvider)}
          >
            <option value="gemini">Gemini 2.5 Pro</option>
            <option value="openai">GPT-5</option>
          </Select>
        </Labeled>
      </div>

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

      <Labeled label="Extra instructions (optional)">
        <Textarea
          value={extraInstructions}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="e.g. keep answers under 90 seconds, always include tradeoffs, I prefer Python over Go"
        />
      </Labeled>

      <Labeled label="Resume (PDF or DOCX, optional)">
        <div className="flex flex-col gap-2">
          <input
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={handleResumeChange}
            className="block text-sm file:mr-4 file:rounded-md file:border file:border-neutral-300 file:bg-neutral-100 file:px-3 file:py-1.5 file:text-sm file:font-medium dark:file:border-neutral-700 dark:file:bg-neutral-800"
          />
          <ResumeStatus status={resumeStatus} fileName={resumeFile?.name} />
        </div>
      </Labeled>

      <div className="flex items-center justify-between gap-4 pt-2">
        <div className="text-xs text-neutral-500">
          <span className="font-mono">session: {sessionId.slice(0, 8)}</span>
          <button
            type="button"
            onClick={regenerateSession}
            className="ml-3 underline hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            new session
          </button>
          {hasPriorSession ? (
            <button
              type="button"
              onClick={duplicateLastSession}
              className="ml-3 underline hover:text-neutral-700 dark:hover:text-neutral-300"
            >
              duplicate last session
            </button>
          ) : null}
        </div>
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Start session →'}
        </Button>
      </div>
    </form>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-neutral-700 dark:text-neutral-300">{label}</span>
      {children}
    </label>
  );
}

function ResumeStatus({
  status,
  fileName,
}: {
  status:
    | { kind: 'idle' }
    | { kind: 'uploading' }
    | { kind: 'ok'; chars: number }
    | { kind: 'err'; msg: string };
  fileName?: string;
}) {
  if (status.kind === 'idle') return null;
  if (status.kind === 'uploading') {
    return <p className="text-xs text-neutral-500">uploading {fileName}…</p>;
  }
  if (status.kind === 'ok') {
    return (
      <p className={cn('text-xs text-emerald-700 dark:text-emerald-400')}>
        ✓ parsed {status.chars.toLocaleString()} characters
      </p>
    );
  }
  return <p className="text-xs text-red-600 dark:text-red-400">× {status.msg}</p>;
}
