import type { ProviderCatalogItem, ProviderExtensionInspect } from "@nanasa/contracts";
import { PackageCheck, RefreshCw, ShieldCheck, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import type { PortalClient } from "../api.js";
import { ErrorNotice, type PortalError, toPortalError } from "../errors.js";

function ExtensionActionButton({
  label,
  description,
  disabledReason,
  disabled,
  className,
  icon,
  onClick,
}: {
  label: string;
  description: string;
  disabledReason?: string;
  disabled: boolean;
  className?: string;
  icon?: ReactNode;
  onClick(): void;
}) {
  const tooltipId = useId();
  const tooltip = disabled && disabledReason !== undefined ? disabledReason : description;
  return (
    <span
      className="extension-action-control"
      {...(disabled ? { tabIndex: 0, "aria-label": label, "aria-describedby": tooltipId } : {})}
    >
      <button
        type="button"
        className={className}
        disabled={disabled}
        aria-describedby={tooltipId}
        onClick={onClick}
      >
        {icon}
        {label}
      </button>
      <span id={tooltipId} className="extension-action-tooltip" role="tooltip">
        {tooltip}
      </span>
    </span>
  );
}

export function ExtensionsWorkspace({
  client,
  revision,
  onChanged,
}: {
  client: PortalClient;
  revision: number;
  onChanged(): Promise<void>;
}) {
  const [catalog, setCatalog] = useState<ProviderCatalogItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [inspect, setInspect] = useState<ProviderExtensionInspect>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<PortalError>();
  const [removeConfirmation, setRemoveConfirmation] = useState("");

  const load = async (preferredId = selectedId) => {
    const items = await client.listProviderExtensions();
    setCatalog(items);
    const extensionId =
      preferredId !== undefined && items.some((item) => item.descriptor.metadata.id === preferredId)
        ? preferredId
        : items[0]?.descriptor.metadata.id;
    setSelectedId(extensionId);
    setInspect(
      extensionId === undefined ? undefined : await client.inspectProviderExtension(extensionId),
    );
    setError(undefined);
  };

  useEffect(() => {
    void load().catch((cause: unknown) =>
      setError(toPortalError(cause, "Unable to load provider extensions")),
    );
  }, [client, revision]);

  const select = (extensionId: string) => {
    setSelectedId(extensionId);
    setRemoveConfirmation("");
    void client
      .inspectProviderExtension(extensionId)
      .then(setInspect, (cause: unknown) =>
        setError(toPortalError(cause, "Unable to inspect provider extension")),
      );
  };

  const perform = async (name: string, operation: () => Promise<unknown>) => {
    setBusy(name);
    setError(undefined);
    try {
      await operation();
      await load(selectedId);
      await onChanged();
    } catch (cause) {
      setError(toPortalError(cause, "Extension operation failed"));
    } finally {
      setBusy(undefined);
    }
  };

  const planCommand =
    inspect === undefined
      ? undefined
      : {
          planDigest: inspect.plan.planDigest,
          configRevision: inspect.plan.configRevision,
          expectedLockRevision: inspect.plan.lockRevision,
        };
  const selected = catalog.find((item) => item.descriptor.metadata.id === selectedId);

  return (
    <div className="extensions-workspace">
      {error !== undefined && <ErrorNotice error={error} className="route-error" />}
      <div className="extension-layout">
        <section
          className="workflow-card extension-catalog"
          aria-labelledby="extension-catalog-title"
        >
          <h3 id="extension-catalog-title">Provider catalog</h3>
          <p>
            Catalog entries are metadata only. Packages cannot supply portal or executable code.
          </p>
          <ul className="extension-list">
            {catalog.map((item) => (
              <li key={item.descriptor.metadata.id}>
                <button
                  type="button"
                  aria-pressed={item.descriptor.metadata.id === selectedId}
                  onClick={() => select(item.descriptor.metadata.id)}
                >
                  <span>
                    <strong>{item.descriptor.metadata.name}</strong>
                    <small>
                      {item.descriptor.metadata.id} · {item.descriptor.metadata.version}
                    </small>
                  </span>
                  <span className={`extension-health health-${item.health.state}`}>
                    {item.health.state}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {inspect !== undefined && selected !== undefined && (
          <section
            className="workflow-card extension-detail"
            aria-labelledby="extension-detail-title"
          >
            <header>
              <div>
                <span className="eyebrow">{selected.descriptor.metadata.publisher}</span>
                <h3 id="extension-detail-title">{selected.descriptor.metadata.name}</h3>
                <p>{selected.descriptor.metadata.description}</p>
              </div>
              <span className={`extension-health health-${selected.health.state}`}>
                {selected.health.state}
              </span>
            </header>

            <dl className="extension-facts">
              <div>
                <dt>Package</dt>
                <dd>
                  {selected.descriptor.metadata.id}@{selected.descriptor.metadata.version}
                </dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>
                  {selected.source.kind === "builtin" ? "Built into Nanasa" : selected.source.label}
                </dd>
              </div>
              <div>
                <dt>Signature</dt>
                <dd>{selected.signatureState}</dd>
              </div>
              <div>
                <dt>Digest</dt>
                <dd>
                  <code>{selected.packageDigest}</code>
                </dd>
              </div>
              <div>
                <dt>Reporter protocol</dt>
                <dd>{selected.descriptor.compatibility.reporterProtocol}</dd>
              </div>
              <div>
                <dt>Lock revision</dt>
                <dd>{inspect.plan.lockRevision}</dd>
              </div>
            </dl>

            {selected.health.diagnostics.length > 0 && (
              <section
                className="extension-diagnostics"
                aria-labelledby="extension-diagnostics-title"
              >
                <h4 id="extension-diagnostics-title">Health and drift</h4>
                <ul>
                  {selected.health.diagnostics.map((diagnostic, index) => (
                    <li key={`${diagnostic.code}:${index}`}>
                      <strong>{diagnostic.code}</strong> {diagnostic.message}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="extension-preview-grid">
              <section>
                <h4>
                  <ShieldCheck aria-hidden="true" size={16} /> Permission preview
                </h4>
                <ul>
                  {inspect.plan.permissions.map((permission) => (
                    <li key={permission}>{permission}</li>
                  ))}
                </ul>
              </section>
              <section>
                <h4>
                  <PackageCheck aria-hidden="true" size={16} /> Owned mutations
                </h4>
                <ul>
                  {inspect.plan.mutations.map((mutation) => (
                    <li key={mutation.ownershipKey}>
                      <strong>{mutation.kind}</strong> {mutation.target}
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            <section
              className="extension-command-preview"
              aria-labelledby="extension-command-title"
            >
              <h4 id="extension-command-title">Provider command preview</h4>
              {inspect.plan.commands.length === 0 ? (
                <p>No configured integrations are impacted.</p>
              ) : (
                <ul>
                  {inspect.plan.commands.map((command) => (
                    <li key={command.integrationId}>
                      <strong>{command.integrationId}</strong>
                      <code>{[command.executable, ...command.argv].join(" ")}</code>
                      <small>
                        cwd {command.cwd} · environment names {command.environmentNames.join(", ")}
                      </small>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="extension-actions" aria-label="Extension lifecycle actions">
              <ExtensionActionButton
                label="Approve exact plan"
                description="Approve the displayed package, permissions, commands, and managed changes. A changed plan requires new approval."
                disabled={busy !== undefined}
                icon={<ShieldCheck aria-hidden="true" size={15} />}
                onClick={() =>
                  void perform("trust", () =>
                    client.trustProviderExtension(selected.descriptor.metadata.id, {
                      planDigest: inspect.plan.planDigest,
                      configRevision: inspect.plan.configRevision,
                    }),
                  )
                }
              />
              {!selected.installed ? (
                <ExtensionActionButton
                  label="Install"
                  description="Install this approved provider extension and apply its Nanasa-owned configuration."
                  className="primary-button"
                  disabled={busy !== undefined || planCommand === undefined}
                  icon={<PackageCheck aria-hidden="true" size={15} />}
                  onClick={() =>
                    void perform("install", () =>
                      client.installProviderExtension(
                        selected.descriptor.metadata.id,
                        planCommand!,
                      ),
                    )
                  }
                />
              ) : (
                <>
                  <ExtensionActionButton
                    label="Repair owned state"
                    description="Restore Nanasa-owned provider files and settings without changing authentication, sessions, or unrelated configuration."
                    disabled={busy !== undefined || planCommand === undefined}
                    icon={<Wrench aria-hidden="true" size={15} />}
                    onClick={() =>
                      void perform("repair", () =>
                        client.repairProviderExtension(
                          selected.descriptor.metadata.id,
                          planCommand!,
                        ),
                      )
                    }
                  />
                  <ExtensionActionButton
                    label="Disable"
                    description="Prevent this provider extension from being used for new runs. Provider state is retained."
                    disabled={busy !== undefined}
                    onClick={() =>
                      void perform("disable", () =>
                        client.disableProviderExtension(selected.descriptor.metadata.id, {
                          expectedLockRevision: inspect.plan.lockRevision,
                        }),
                      )
                    }
                  />
                  <ExtensionActionButton
                    label="Rollback"
                    description="Restore the previous verified extension generation."
                    {...(selected.health.rollbackAvailable
                      ? {}
                      : { disabledReason: "No previous verified generation is available." })}
                    disabled={busy !== undefined || !selected.health.rollbackAvailable}
                    onClick={() =>
                      void perform("rollback", () =>
                        client.rollbackProviderExtension(selected.descriptor.metadata.id, {
                          expectedLockRevision: inspect.plan.lockRevision,
                        }),
                      )
                    }
                  />
                </>
              )}
              <ExtensionActionButton
                label="Refresh health"
                description="Check command availability, package integrity, compatibility, approval, and configuration drift again."
                disabled={busy !== undefined}
                icon={<RefreshCw aria-hidden="true" size={15} />}
                onClick={() => void load(selectedId)}
              />
            </div>

            {selected.installed && (
              <fieldset className="extension-remove">
                <legend>Conservative removal</legend>
                <p>
                  Provider state, authentication, sessions, and changed files are retained.
                  Referenced extensions cannot be removed.
                </p>
                <label>
                  Type {selected.descriptor.metadata.id} to confirm
                  <input
                    value={removeConfirmation}
                    onChange={(event) => setRemoveConfirmation(event.target.value)}
                  />
                </label>
                <ExtensionActionButton
                  label="Remove from Nanasa"
                  description="Remove this extension from Nanasa while retaining provider state, authentication, sessions, and changed files."
                  disabledReason={`Type ${selected.descriptor.metadata.id} above to enable removal.`}
                  className="danger-button"
                  disabled={
                    busy !== undefined || removeConfirmation !== selected.descriptor.metadata.id
                  }
                  onClick={() =>
                    void perform("remove", () =>
                      client.removeProviderExtension(selected.descriptor.metadata.id, {
                        expectedLockRevision: inspect.plan.lockRevision,
                      }),
                    )
                  }
                />
              </fieldset>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
