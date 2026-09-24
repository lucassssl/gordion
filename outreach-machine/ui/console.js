const $ = (id) => document.getElementById(id);
const labels = {
  needs_review: "Prüfung offen",
  eligible: "Geprüft",
  suppressed: "Gesperrt",
  draft: "Entwurf",
  paused: "Pausiert",
  awaiting_approval: "Freigabe offen",
  approved: "Inhalt freigegeben",
  reconciliation_required: "Klärung erforderlich",
  cancelled: "Gestoppt",
  sent_confirmed: "Gesendet bestätigt",
  send_accepted: "Von Microsoft angenommen",
};
let data = { contacts: [], campaigns: [], messages: [] },
  selectedMessage = null;
function note(text, error = false) {
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
  $("notice").hidden = false;
}
async function api(url, body) {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error === "invalid_input"
        ? `Bitte Eingaben prüfen: ${result.fields.join(", ")}`
        : result.error === "batch_content_conflict"
          ? "Diese Lauf-ID wurde bereits mit anderen Daten verwendet."
          : `Aktion fehlgeschlagen (${response.status}). Keine Versandaktivierung.`,
    );
  return result;
}
async function action(fn) {
  try {
    await fn();
  } catch (error) {
    note(error.message, true);
  }
}
function el(tag, text, className) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = String(text);
  if (className) n.className = className;
  return n;
}
function button(text, fn, cls = "quiet") {
  const b = el("button", text, cls);
  b.type = "button";
  b.onclick = () =>
    action(async () => {
      b.disabled = true;
      try {
        await fn();
      } finally {
        b.disabled = false;
      }
    });
  return b;
}
function show(view) {
  document.querySelectorAll(".view").forEach((n) => {
    n.hidden = n.id !== view;
  });
  document
    .querySelectorAll("[data-view]")
    .forEach((n) => n.classList.toggle("active", n.dataset.view === view));
  $("breadcrumb").textContent = document.querySelector(
    `[data-view="${view}"] span`,
  ).textContent;
}
document
  .querySelectorAll("[data-view], [data-go]")
  .forEach((b) => (b.onclick = () => show(b.dataset.view || b.dataset.go)));
document
  .querySelectorAll("[data-close]")
  .forEach((b) => (b.onclick = () => $(b.dataset.close).close()));
function empty(container, title, text) {
  const n = el("div", undefined, "empty");
  n.append(el("h3", title), el("p", text));
  container.append(n);
}
function sourceLink(url, title) {
  const link = el("a", title);
  try {
    const parsed = new URL(url);
    if (["http:", "https:"].includes(parsed.protocol)) {
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  } catch {}
  return link;
}
function renderContacts() {
  const body = $("contacts-body");
  body.replaceChildren();
  const query = $("contact-search").value.toLowerCase(),
    status = $("contact-filter").value;
  const contacts = data.contacts.filter(
    (c) =>
      `${c.companyName} ${c.email} ${c.roleTitle}`
        .toLowerCase()
        .includes(query) &&
      (status === "all" || c.reviewStatus === status),
  );
  for (const contact of contacts) {
    const row = el("tr"),
      name = el("td"),
      role = el("td"),
      source = el("td"),
      state = el("td"),
      actions = el("td");
    name.append(el("strong", contact.companyName), el("small", contact.email));
    role.append(
      el("span", contact.roleTitle || "Rolle offen"),
      el(
        "small",
        `${contact.countryCode || "Land offen"} · Fit ${contact.fitTier || "offen"}`,
      ),
    );
    source.append(
      sourceLink(contact.sourceUrl, "Kontaktquelle ↗"),
      el(
        "small",
        new Date(contact.sourceCheckedAt).toLocaleDateString("de-DE"),
      ),
    );
    state.append(
      el(
        "span",
        labels[contact.reviewStatus] || contact.reviewStatus,
        `tag ${contact.reviewStatus === "needs_review" ? "amber" : ""}`,
      ),
    );
    if (contact.authorized) state.append(el("small", "Nachweis hinterlegt"));
    if (contact.reviewStatus !== "suppressed") {
      actions.append(
        button("Prüfen", () => {
          $("review-form").reset();
          $("review-id").value = contact.id;
          $("review-contact").textContent =
            `${contact.companyName} · ${contact.email}`;
          $("review-evidence").textContent = contact.executionEvidence;
          $("review-expiry").value = new Date(Date.now() + 30 * 86400000)
            .toISOString()
            .slice(0, 10);
          $("review-dialog").showModal();
        }),
        button("Sperren", async () => {
          if (
            !confirm(`${contact.email} sperren und offene Sequenzen stoppen?`)
          )
            return;
          await api(`/v1/contacts/${contact.id}/suppress`, {
            reason: "Manuelle Sperre in der lokalen Oberfläche",
          });
          await refresh();
          note("Kontakt gesperrt.");
        }),
      );
    }
    row.append(name, role, source, state, actions);
    body.append(row);
  }
  $("contacts-empty").hidden = contacts.length > 0;
}
function renderCampaigns() {
  const list = $("campaign-list");
  list.replaceChildren();
  if (!data.campaigns.length)
    empty(
      list,
      "Deine erste Kampagne beginnt hier.",
      "Lege eine Vorlage und klare Regeln an. Eine Kampagne startet immer ohne Versand.",
    );
  for (const campaign of data.campaigns) {
    const card = el("article", undefined, "panel");
    card.append(
      el("span", "KEIN LIVEVERSAND", "tag amber"),
      el("h3", campaign.name),
      el(
        "p",
        `${campaign.targetCountries.join(", ")} · ${campaign.dailyInitialLimit} neue / ${campaign.dailyTotalLimit} gesamt pro Tag`,
      ),
      el(
        "p",
        `Vorbereitung: ${campaign.preparationMode === "automatic" ? "automatisch alle 30 Sekunden" : "manuell"}`,
      ),
    );
    card.append(
      button("Vorschauen vorbereiten", async () => {
        const result = await api(`/v1/campaigns/${campaign.id}/prepare`, {});
        await refresh();
        note(
          `${result.prepared} Nachrichten vorbereitet. Nur geprüfte Kontakte ohne bisherige Sequenz werden berücksichtigt.`,
        );
      }),
      button(
        campaign.preparationMode === "automatic"
          ? "Automatik pausieren"
          : "Vorbereitung automatisieren",
        async () => {
          const enable = campaign.preparationMode !== "automatic";
          if (
            enable &&
            !confirm(
              "Neue, bereits geprüfte Kontakte mit gültiger Versandgrundlage automatisch mit dieser Vorlage vorbereiten und den Inhalt freigeben? Kein Versand wird aktiviert.",
            )
          )
            return;
          await api(`/v1/campaigns/${campaign.id}/automation`, {
            enabled: enable,
            confirmation: "PREPARATION_ONLY_NO_SEND",
          });
          await refresh();
          note("Vorbereitungsregel gespeichert. Versand bleibt aus.");
        },
      ),
    );
    list.append(card);
  }
}
function renderMessages() {
  const body = $("messages-body");
  body.replaceChildren();
  $("messages-empty").hidden = data.messages.length > 0;
  for (const message of data.messages) {
    const row = el("tr"),
      recipient = el("td", message.recipientAddress),
      subject = el("td"),
      state = el("td"),
      actions = el("td");
    subject.append(
      el("strong", message.finalSubject),
      el("small", message.campaignName),
    );
    state.append(el("span", labels[message.status] || message.status, "tag"));
    actions.append(
      button("Ansehen →", () => {
        selectedMessage = message;
        $("preview-recipient").textContent = `An: ${message.recipientAddress}`;
        $("preview-subject").textContent = message.finalSubject;
        $("preview-body").textContent = message.finalBodyText;
        $("approve-message").hidden = message.status !== "awaiting_approval";
        $("message-dialog").showModal();
      }),
    );
    row.append(recipient, subject, state, actions);
    body.append(row);
  }
}
async function refresh() {
  const [fresh, system] = await Promise.all([
    api("/v1/console"),
    api("/v1/system/status"),
  ]);
  data = fresh;
  $("metric-contacts").textContent = data.contacts.length;
  $("nav-count").textContent = data.contacts.length;
  $("metric-reviewed").textContent = data.contacts.filter(
    (c) => c.authorized && c.reviewStatus === "eligible",
  ).length;
  $("metric-messages").textContent = data.messages.length;
  $("pause-state").textContent = system.control?.globallyPaused
    ? "Global pausiert"
    : "Lokale Versandsperre aktiv";
  renderContacts();
  renderCampaigns();
  renderMessages();
  $("activity").replaceChildren();
  if (!data.audit.length)
    empty(
      $("activity"),
      "Noch keine Aktivitäten",
      "Importe, Prüfungen und Freigaben erscheinen hier.",
    );
  for (const entry of data.audit.slice(0, 6)) {
    const n = el("div", entry.eventType);
    n.append(
      el(
        "small",
        `${new Date(entry.occurredAt).toLocaleString("de-DE")} · ${entry.actorId}`,
      ),
    );
    $("activity").append(n);
  }
  $("import-history").replaceChildren();
  if (!data.imports.length)
    empty(
      $("import-history"),
      "Noch kein Import",
      "Wiederholungen mit derselben Lauf-ID erzeugen keine neuen Kontakte.",
    );
  for (const batch of data.imports) {
    const n = el("div", batch.externalId);
    n.append(
      el(
        "small",
        `${batch.importedCount} neu · ${batch.duplicateCount} Dubletten · ${batch.blockedCount} gesperrt`,
      ),
    );
    $("import-history").append(n);
  }
}
$("refresh").onclick = () => action(refresh);
$("contact-search").oninput = renderContacts;
$("contact-filter").onchange = renderContacts;
$("pause").onclick = () =>
  action(async () => {
    await api("/v1/system/pause", {
      reason: "Globale Pause über lokale Oberfläche",
      actor: "local-admin",
    });
    await refresh();
    note("Alle Kampagnen global pausiert.");
  });
$("sample-import").onclick = () => {
  $("import-json").value = JSON.stringify(
    {
      externalId: `synthetic-example-${new Date().toISOString().slice(0, 10)}`,
      source: "manual",
      contacts: [
        {
          companyName: "Beispiel Wertpapierfirma – Testdaten",
          domain: "demo-broker.example",
          countryCode: "DE",
          fitTier: "A",
          email: "compliance@demo-broker.example",
          firstName: "Test",
          roleTitle: "Compliance",
          sourceUrl: "https://demo-broker.example/team",
          sourceCheckedAt: `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
          executionEvidence:
            "Ausschließlich synthetische Testdaten, kein tatsächlich recherchiertes Unternehmen.",
          executionEvidenceUrl: "https://demo-broker.example/services",
        },
      ],
    },
    null,
    2,
  );
};
$("import-file").onchange = () =>
  action(async () => {
    const file = $("import-file").files[0];
    if (!file) return;
    if (file.size > 900000)
      throw new Error("Bitte eine JSON-Datei unter 900 KB auswählen.");
    $("import-json").value = await file.text();
  });
$("import-form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    const result = await api("/v1/imports", JSON.parse($("import-json").value));
    $("import-result").textContent =
      `${result.importedCount} neu · ${result.duplicateCount} Dubletten · ${result.blockedCount} gesperrt${result.replayed ? " · bereits verarbeiteter Lauf" : ""}`;
    $("import-result").hidden = false;
    await refresh();
    note("Import abgeschlossen. Keine Versandfreigabe erteilt.");
  });
};
$("review-form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    await api(`/v1/contacts/${$("review-id").value}/authorize`, {
      basis: $("review-basis").value,
      evidence: $("review-reference").value,
      validUntil: new Date(
        `${$("review-expiry").value}T23:59:59`,
      ).toISOString(),
      confirmation: "VERIFY_OUTREACH_BASIS",
    });
    $("review-dialog").close();
    await refresh();
    note("Prüfung und Versandgrundlage dokumentiert.");
  });
};
$("new-campaign").onclick = () => $("campaign-dialog").showModal();
$("campaign-form").onsubmit = (event) => {
  event.preventDefault();
  action(async () => {
    const fields = Object.fromEntries(new FormData(event.target));
    await api("/v1/campaigns", {
      ...fields,
      countries: fields.countries
        .split(",")
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean),
      initialLimit: Number(fields.initialLimit),
      totalLimit: Number(fields.totalLimit),
      confirmation: "APPROVE_TEMPLATE_ONLY",
    });
    $("campaign-dialog").close();
    event.target.reset();
    await refresh();
    note("Kampagne gespeichert. Versand bleibt aus.");
  });
};
$("approve-message").onclick = () =>
  action(async () => {
    if (!selectedMessage) return;
    await api(`/v1/messages/${selectedMessage.id}/approve`, {
      contentSha256: selectedMessage.contentSha256,
    });
    $("message-dialog").close();
    await refresh();
    note("Genauer Nachrichteninhalt freigegeben. Kein Versand ausgelöst.");
  });
action(async () => {
  await api("/local/session", {});
  await refresh();
});
