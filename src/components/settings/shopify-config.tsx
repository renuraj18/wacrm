'use client';

// ============================================================
// ShopifyConfig — Settings → Shopify
//
// Connect a Shopify store (Dev Dashboard app, client-credentials
// grant), see sync status, trigger a manual sync, toggle whether the
// catalogue feeds AI answers, and disconnect. Admin-only: the API
// routes and the shopify_config RLS both require admin+, and agents /
// viewers see a read-only notice instead of the form.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { CheckCircle2, ExternalLink, Loader2, RefreshCw, ShoppingBag, Unplug } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import { SettingsPanelHead } from './settings-panel-head';

interface ShopifyStatus {
  shop_domain: string;
  client_id: string;
  storefront_url: string | null;
  currency: string | null;
  ai_products_enabled: boolean;
  webhooks_registered_at: string | null;
  last_synced_at: string | null;
  last_sync_error: string | null;
  product_count: number;
  created_at: string;
}

const SECRET_MASK = '••••••••••••••••';
const POLL_MS = 3000;
const POLL_LIMIT = 40;

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ShopifyConfig() {
  const t = useTranslations('Settings.shopify');
  const { canEditSettings } = useAuth();

  const [config, setConfig] = useState<ShopifyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [shopDomain, setShopDomain] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [secretEdited, setSecretEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors secretEdited for `load`, so a refresh never clobbers a
  // secret that is being typed (and `load` stays stable).
  const secretEditedRef = useRef(false);
  useEffect(() => {
    secretEditedRef.current = secretEdited;
  }, [secretEdited]);

  const load = useCallback(async (): Promise<ShopifyStatus | null> => {
    try {
      const res = await fetch('/api/shopify/config', { cache: 'no-store' });
      if (!res.ok) {
        if (res.status !== 403) {
          const payload = await res.json().catch(() => ({}));
          toast.error(payload.error || t('loadFailed'));
        }
        return null;
      }
      const data = (await res.json()) as { config: ShopifyStatus | null };
      setConfig(data.config);
      if (data.config) {
        setShopDomain(data.config.shop_domain);
        setClientId(data.config.client_id);
        if (!secretEditedRef.current) setClientSecret(SECRET_MASK);
      }
      return data.config;
    } catch {
      toast.error(t('networkError'));
      return null;
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (canEditSettings) void load();
    else setLoading(false);
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [canEditSettings, load]);

  /** Poll until last_synced_at moves past `since` (or an error lands). */
  const pollForSync = useCallback(
    (since: string | null) => {
      let tries = 0;
      setSyncing(true);
      const tick = async () => {
        tries += 1;
        const next = await load();
        const done =
          !!next &&
          ((next.last_synced_at && next.last_synced_at !== since) ||
            (next.last_sync_error && tries > 1));
        if (done || tries >= POLL_LIMIT) {
          setSyncing(false);
          if (next?.last_sync_error) toast.error(t('syncFailed', { error: next.last_sync_error }));
          else if (done) toast.success(t('syncDone', { count: next!.product_count }));
          return;
        }
        pollTimer.current = setTimeout(tick, POLL_MS);
      };
      pollTimer.current = setTimeout(tick, POLL_MS);
    },
    [load, t],
  );

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch('/api/shopify/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop_domain: shopDomain,
          client_id: clientId,
          client_secret: secretEdited ? clientSecret : '',
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('saveFailed'));
        return;
      }
      toast.success(t('connected', { name: payload.shop_name ?? shopDomain }));
      if (payload.webhook_error) toast.warning(t('webhookWarning', { error: payload.webhook_error }));
      setSecretEdited(false);
      const since = config?.last_synced_at ?? null;
      await load();
      pollForSync(since);
    } catch {
      toast.error(t('networkError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleSync() {
    const since = config?.last_synced_at ?? null;
    try {
      const res = await fetch('/api/shopify/sync', { method: 'POST' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('syncStartFailed'));
        return;
      }
      toast.message(t('syncStarted'));
      pollForSync(since);
    } catch {
      toast.error(t('networkError'));
    }
  }

  async function handleToggleAi(next: boolean) {
    if (!config) return;
    setConfig({ ...config, ai_products_enabled: next });
    const res = await fetch('/api/shopify/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_products_enabled: next }),
    }).catch(() => null);
    if (!res?.ok) {
      setConfig({ ...config, ai_products_enabled: !next });
      toast.error(t('saveFailed'));
      return;
    }
    toast.success(next ? t('aiOn') : t('aiOff'));
  }

  async function handleDisconnect() {
    if (!window.confirm(t('disconnectConfirm'))) return;
    setDisconnecting(true);
    try {
      const res = await fetch('/api/shopify/config', { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('disconnectFailed'));
        return;
      }
      setConfig(null);
      setShopDomain('');
      setClientId('');
      setClientSecret('');
      setSecretEdited(false);
      toast.success(t('disconnected'));
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  if (!canEditSettings) {
    return (
      <section className="animate-in fade-in-50 space-y-6 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">{t('adminOnly')}</CardContent>
        </Card>
      </section>
    );
  }

  const canSave = shopDomain.trim() && clientId.trim() && (config ? true : clientSecret.trim());

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          config ? (
            <Button variant="outline" onClick={handleSync} disabled={syncing}>
              {syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              {syncing ? t('syncing') : t('syncNow')}
            </Button>
          ) : null
        }
      />

      {config ? (
        <Card>
          <CardContent className="space-y-3 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <CheckCircle2 className="size-4 text-emerald-500" />
              <span className="text-sm font-medium text-foreground">
                {t('connectedTo', { shop: config.storefront_url ?? config.shop_domain })}
              </span>
              <Badge variant="secondary">{t('productCount', { count: config.product_count })}</Badge>
              {config.webhooks_registered_at ? (
                <Badge variant="secondary">{t('liveUpdates')}</Badge>
              ) : (
                <Badge variant="destructive">{t('noLiveUpdates')}</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {config.last_synced_at
                ? t('lastSynced', { when: fmtDateTime(config.last_synced_at) })
                : t('neverSynced')}
            </p>
            {config.last_sync_error ? (
              <p className="text-xs text-destructive">{t('lastError', { error: config.last_sync_error })}</p>
            ) : null}
            <div className="flex flex-wrap gap-3 pt-1 text-sm">
              <Link href="/products" className="inline-flex items-center gap-1 text-primary hover:underline">
                <ShoppingBag className="size-4" />
                {t('viewProducts')}
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="space-y-4 py-5">
          <div className="space-y-1.5">
            <Label htmlFor="shopify-domain">{t('shopDomain')}</Label>
            <Input
              id="shopify-domain"
              value={shopDomain}
              onChange={(e) => setShopDomain(e.target.value)}
              placeholder="your-store.myshopify.com"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">{t('shopDomainHint')}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="shopify-client-id">{t('clientId')}</Label>
            <Input
              id="shopify-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="shopify-client-secret">{t('clientSecret')}</Label>
            <Input
              id="shopify-client-secret"
              type="password"
              value={clientSecret}
              onFocus={() => {
                if (!secretEdited && config) setClientSecret('');
              }}
              onBlur={() => {
                if (!secretEdited && config) setClientSecret(SECRET_MASK);
              }}
              onChange={(e) => {
                setSecretEdited(true);
                setClientSecret(e.target.value);
              }}
              autoComplete="new-password"
            />
            {config ? <p className="text-xs text-muted-foreground">{t('clientSecretSaved')}</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleSave} disabled={saving || !canSave}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {config ? t('saveChanges') : t('connect')}
            </Button>
            {config ? (
              <Button variant="outline" onClick={handleDisconnect} disabled={disconnecting}>
                <Unplug className="size-4" />
                {t('disconnect')}
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {config ? (
        <Card>
          <CardContent className="flex items-center justify-between gap-4 py-4">
            <div>
              <p className="text-sm font-medium text-foreground">{t('aiToggle')}</p>
              <p className="text-xs text-muted-foreground">{t('aiToggleDesc')}</p>
            </div>
            <Switch checked={config.ai_products_enabled} onCheckedChange={handleToggleAi} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="space-y-2 py-5 text-sm">
          <p className="font-medium text-foreground">{t('setupTitle')}</p>
          <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
            <li>
              {t('step1')}{' '}
              <a
                href="https://dev.shopify.com/dashboard"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-primary hover:underline"
              >
                dev.shopify.com <ExternalLink className="size-3" />
              </a>
            </li>
            <li>{t('step2')}</li>
            <li>{t('step3')}</li>
            <li>{t('step4')}</li>
            <li>{t('step5')}</li>
          </ol>
        </CardContent>
      </Card>
    </section>
  );
}
