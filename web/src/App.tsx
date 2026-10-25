import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

interface Chat {
  id: string;
  name: string;
  watched: boolean;
  mayReply: boolean;
}

interface Message {
  seq: number;
  chatId: string;
  chatName: string;
  sender: string;
  fromMe: boolean;
  fromAgent: boolean;
  text: string;
  timestamp: number;
}

interface State {
  status: 'starting' | 'qr' | 'connecting' | 'open' | 'closed' | 'loggedOut';
  qr?: string;
  signature: string;
  webhook: boolean;
  chats: Chat[];
  messages: Message[];
}

const STATUS: Record<State['status'], { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  open: { label: 'Connected', variant: 'default' },
  qr: { label: 'Scan QR code', variant: 'secondary' },
  connecting: { label: 'Linking…', variant: 'outline' },
  starting: { label: 'Connecting…', variant: 'outline' },
  closed: { label: 'Disconnected', variant: 'destructive' },
  loggedOut: { label: 'Logged out', variant: 'destructive' },
};

const SHOWN_CHATS = 100;
const PRIMARY_BUTTON =
  'h-8 shrink-0 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50';

export function App() {
  const [state, setState] = useState<State>();
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<string>();

  const refresh = useCallback(() => {
    fetch('/api/state')
      .then((r) => r.json())
      .then(setState)
      .catch(() => setError('Cannot reach the wawatch service.'));
  }, []);

  useEffect(() => {
    refresh();
    const events = new EventSource('/api/events');
    events.addEventListener('state', refresh);
    events.addEventListener('message', (e) => {
      const m = JSON.parse((e as MessageEvent).data) as Message;
      setState((s) => s && { ...s, messages: [...s.messages, m].slice(-200) });
    });
    events.onopen = () => setError(undefined);
    events.onerror = () => setError('Lost connection to the wawatch service. Retrying…');
    return () => events.close();
  }, [refresh]);

  const update = async (id: string, patch: Partial<Pick<Chat, 'watched' | 'mayReply'>>) => {
    const r = await fetch(`/api/chats/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) setError((await r.json()).error);
    refresh();
  };

  const saveSignature = async (e: FormEvent<HTMLFormElement>, value: string) => {
    e.preventDefault();
    const r = await fetch('/api/signature', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signature: value }),
    });
    if (r.ok) setDraft(undefined);
    else setError((await r.json()).error);
    refresh();
  };

  const pairAgain = async () => {
    const r = await fetch('/api/repair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) setError((await r.json()).error);
    refresh();
  };

  const chats = useMemo(
    () => (state?.chats ?? []).filter((c) => c.name.toLowerCase().includes(query.toLowerCase())),
    [state, query],
  );

  if (!state) {
    return <main className="p-6 text-muted-foreground">{error ?? 'Loading…'}</main>;
  }

  const watched = state.chats.filter((c) => c.watched).length;
  const mayReply = state.chats.filter((c) => c.mayReply).length;
  const status = STATUS[state.status];
  const signature = draft ?? state.signature;

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">wawatch</h1>
          <p className="text-sm text-muted-foreground">
            The AI agent reads <strong>{watched}</strong> {watched === 1 ? 'chat' : 'chats'} and may reply in{' '}
            <strong>{mayReply}</strong>.
          </p>
        </div>
        <Badge variant={status.variant}>{status.label}</Badge>
      </header>

      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {state.status === 'qr' && (
        <Card>
          <CardHeader>
            <CardTitle>Link your WhatsApp</CardTitle>
            <CardDescription>Scan this code with your phone. It refreshes by itself when it expires.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 md:grid-cols-[auto_1fr] md:items-center">
            {state.qr ? (
              <img src={state.qr} alt="WhatsApp pairing QR code" className="size-72 justify-self-center rounded-md border md:size-80" />
            ) : (
              <p className="text-sm text-muted-foreground">Preparing the code…</p>
            )}
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
              <li>Open WhatsApp on your phone and tap Settings.</li>
              <li>Tap Linked devices, then Link a device.</li>
              <li>Point your phone at this code.</li>
            </ol>
          </CardContent>
        </Card>
      )}

      {state.status === 'loggedOut' && (
        <Card>
          <CardHeader>
            <CardTitle>Logged out</CardTitle>
            <CardDescription>
              This device was logged out from your phone. The agent cannot read or send messages until you pair again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <button type="button" onClick={pairAgain} className={PRIMARY_BUTTON}>
              Pair again
            </button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Reply signature</CardTitle>
          <CardDescription>Added to the start of every message the agent sends, so people know it is an AI.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => saveSignature(e, signature)}>
            <Input
              value={signature}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Reply signature"
              aria-invalid={!signature.trim() || undefined}
            />
            <button
              type="submit"
              disabled={!signature.trim()}
              className={PRIMARY_BUTTON}
            >
              Save
            </button>
          </form>
          <p className="break-words text-sm text-muted-foreground">
            Agent messages start with: <code className="rounded bg-muted px-1">{state.signature.trim()}</code>
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Chats</CardTitle>
            <CardDescription>
              <strong>Watch</strong> lets the agent read a chat. <strong>May reply</strong> lets it send messages there
              {state.signature ? (
                <>
                  , always starting with <code className="rounded bg-muted px-1">{state.signature.trim()}</code>
                </>
              ) : null}
              .
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Input
              type="search"
              placeholder="Search chats"
              aria-label="Search chats"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {chats.length === 0 && <p className="text-sm text-muted-foreground">No chats yet.</p>}
            <ul className="flex flex-col divide-y">
              {chats.slice(0, SHOWN_CHATS).map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{c.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{c.id.endsWith('@g.us') ? 'Group' : 'Chat'}</p>
                  </div>
                  <label className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
                    Watch
                    <Switch
                      checked={c.watched}
                      onCheckedChange={(v) => update(c.id, { watched: v })}
                      aria-label={`Watch ${c.name}`}
                    />
                  </label>
                  <label className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
                    May reply
                    <Switch
                      checked={c.mayReply}
                      onCheckedChange={(v) => update(c.id, { mayReply: v })}
                      aria-label={`Agent may reply in ${c.name}`}
                    />
                  </label>
                </li>
              ))}
            </ul>
            {chats.length > SHOWN_CHATS && (
              <p className="text-xs text-muted-foreground">
                Showing {SHOWN_CHATS} of {chats.length}. Search to find others.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Live feed</CardTitle>
            <CardDescription>Messages in watched chats and everything the agent sent.</CardDescription>
          </CardHeader>
          <CardContent>
            {state.messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing yet. Turn on Watch for a chat to see its messages here.</p>
            ) : (
              <ol className="flex flex-col gap-2" aria-live="polite">
                {[...state.messages].reverse().map((m) => (
                  <li
                    key={m.seq}
                    className={`rounded-md border p-2 text-sm ${m.fromAgent ? 'border-primary/40 bg-primary/5' : ''}`}
                  >
                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{m.chatName}</span>
                      <span>·</span>
                      <span>{m.fromAgent ? 'agent' : m.fromMe ? 'you' : m.sender}</span>
                      {m.fromAgent && <Badge variant="outline">sent by agent</Badge>}
                      <time className="ml-auto" dateTime={new Date(m.timestamp).toISOString()}>
                        {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </time>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap break-words">{m.text}</p>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
