"use client";

// ============================================================
// Abandoned checkouts — customers who left before paying. Select who to
// remind on WhatsApp. Agents and above.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCan } from "@/hooks/use-can";

interface Checkout {
  id: string;
  name: string;
  customerName: string;
  phone: string | null;
  items: string;
  total: string;
  createdAt: string;
  updatedAt: string;
  remindedAt: string | null;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function AbandonedCheckoutsPage() {
  const canSend = useCan("send-messages");
  const [days, setDays] = useState(7);
  const [checkouts, setCheckouts] = useState<Checkout[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/abandoned-checkouts?days=${days}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load checkouts");
      setCheckouts(data.checkouts);
      setSelected(new Set());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load checkouts");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    if (canSend) void load();
  }, [canSend, load]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function remind(force: boolean) {
    setSending(true);
    try {
      const res = await fetch("/api/abandoned-checkouts/remind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected], force }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not send reminders");
      const sent = data.results.filter((r: { ok: boolean }) => r.ok).length;
      const skipped = data.results.filter((r: { skipped?: boolean }) => r.skipped).length;
      toast.success(`${sent} reminder${sent === 1 ? "" : "s"} sent${skipped ? `, ${skipped} already reminded` : ""}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send reminders");
    } finally {
      setSending(false);
    }
  }

  if (!canSend) {
    return <p className="p-6 text-sm text-muted-foreground">You don&apos;t have access to abandoned checkouts.</p>;
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold text-foreground">Abandoned checkouts</h1>
        <select className="rounded-md border border-border bg-background px-2 py-1 text-sm" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={60}>Last 60 days</option>
        </select>
        <Button variant="outline" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</Button>
        <Button onClick={() => remind(false)} disabled={sending || !selected.size}>Remind selected ({selected.size})</Button>
        <Button variant="outline" onClick={() => remind(true)} disabled={sending || !selected.size}>Remind again</Button>
      </div>

      <div className="divide-y divide-border rounded-lg border border-border">
        {checkouts.length === 0 && !loading && <p className="p-4 text-sm text-muted-foreground">No abandoned checkouts.</p>}
        {checkouts.map((c) => (
          <label key={c.id} className="flex items-start gap-3 p-3">
            <input type="checkbox" className="mt-1" disabled={!c.phone} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-medium text-foreground">{c.customerName || "Customer"} · {c.phone ?? "no phone"}</p>
              <p className="truncate text-muted-foreground">{c.items}</p>
              <p className="text-muted-foreground">₹{c.total} · {c.name}</p>
              <p className="text-xs text-muted-foreground">
                Started {formatTime(c.createdAt)} · Last activity {formatTime(c.updatedAt)}
                {c.remindedAt ? ` · Reminded ${formatTime(c.remindedAt)}` : ""}
              </p>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}
