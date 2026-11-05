/**
 * dsh-ctx-trim — 客户端半边。
 *
 * 会话头部一个「上下文」按钮，点开是两档手动压缩：正常 / 深度。
 * 客户端这边不碰任何宿主服务（服务表里没有 commands / remote），
 * 只做两件事：fetch 宿主路由 + 把返回的文字显示出来。
 */
window.__ModuleLoader__.load({
  id: "dsh-ctx-trim",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const NS = "dsh-ctx-trim";

    const zh = {
      button: "上下文",
      title: "手动压缩",
      sub: "本地摘要，不调模型",
      loading: "读取中…",
      now: "现在",
      items: "条",
      running: "这个会话正在跑，等这一轮结束再压。",
      normal: "正常压缩",
      normalDesc: "切掉较早一段，保留最近三成近文；切点落在结构边界上。",
      deep: "深度压缩",
      deepDesc: "切更大范围，只留最近一成；切下的原文打包进 im/ctxpacks/。",
      working: "处理中…",
      close: "关闭",
      hint: "压缩不可撤销；会话里会留下一段压缩标记。",
      unavailable: "读不到这个会话的状态。",
    };
    const en = {
      button: "Context",
      title: "Manual compaction",
      sub: "Local summary, no model call",
      loading: "Loading…",
      now: "Now",
      items: "items",
      running: "This session is running — trim after the turn ends.",
      normal: "Normal",
      normalDesc: "Cut the older span, keep the recent third; cuts land on structural boundaries.",
      deep: "Deep",
      deepDesc: "Cut more, keep the last tenth; the cut text is packed into im/ctxpacks/.",
      working: "Working…",
      close: "Close",
      hint: "Compaction cannot be undone; it leaves a checkpoint in the session.",
      unavailable: "Cannot read this session's state.",
    };

    const T = {
      wrap: { position: "relative", display: "inline-flex" },
      trigger: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 26,
        padding: "0 10px",
        borderRadius: 8,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary)",
        fontSize: 12,
        lineHeight: 1,
        cursor: "pointer",
      },
      dot: {
        width: 6,
        height: 6,
        borderRadius: 999,
        background: "var(--dsw-alias-state-business-primary, #3964fe)",
      },
      panel: {
        position: "absolute",
        left: 0,
        top: "calc(100% + 8px)",
        zIndex: 60,
        width: 340,
        padding: 16,
        borderRadius: 14,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-2, #1c1c1f)",
        boxShadow: "0 18px 48px rgba(0,0,0,.38)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        textAlign: "left",
      },
      head: { display: "flex", alignItems: "baseline", gap: 8 },
      title: { fontSize: 14, fontWeight: 650, color: "var(--dsw-alias-label-primary)" },
      sub: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" },
      meter: { fontSize: 11.5, color: "var(--dsw-alias-label-secondary)" },
      card: {
        textAlign: "left",
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "transparent",
        borderRadius: 10,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 3,
        cursor: "pointer",
      },
      cardName: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      cardDesc: { fontSize: 11.5, lineHeight: 1.55, color: "var(--dsw-alias-label-tertiary)" },
      ok: { fontSize: 11.5, lineHeight: 1.5, color: "var(--dsw-alias-state-success-primary, #2ea043)" },
      err: { fontSize: 11.5, lineHeight: 1.5, color: "var(--dsw-alias-state-error-primary, #f85149)" },
      note: { fontSize: 11, lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)" },
      foot: { display: "flex", justifyContent: "flex-end" },
      close: {
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary)",
        borderRadius: 8,
        padding: "5px 14px",
        fontSize: 12,
        cursor: "pointer",
      },
    };

    function formatTokens(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return "?";
      if (value >= 1000) return (value / 1000).toFixed(1) + "k";
      return String(value);
    }

    function makeButton(t) {
      return function TrimButton(props) {
        const [open, setOpen] = React.useState(false);
        const [info, setInfo] = React.useState(null);
        const [loadError, setLoadError] = React.useState("");
        const [busy, setBusy] = React.useState("");
        const [message, setMessage] = React.useState(null);
        const [tick, setTick] = React.useState(0);
        const wrapRef = React.useRef(null);
        const sessionId = props.sessionId;

        React.useEffect(() => {
          if (!open) return undefined;
          function onDown(event) {
            if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
          }
          document.addEventListener("mousedown", onDown);
          return () => document.removeEventListener("mousedown", onDown);
        }, [open]);

        React.useEffect(() => {
          if (!open || !sessionId) return undefined;
          let cancelled = false;
          setLoadError("");
          fetch(`/dsh-ctx-trim/status?sessionId=${encodeURIComponent(sessionId)}`)
            .then((response) => response.json())
            .then((data) => {
              if (cancelled) return;
              setInfo(data);
              if (!data || data.ok === false) setLoadError((data && data.message) || t("unavailable"));
            })
            .catch((error) => {
              if (!cancelled) setLoadError(String((error && error.message) || error));
            });
          return () => {
            cancelled = true;
          };
        }, [open, sessionId, tick]);

        function run(mode) {
          if (busy || !sessionId) return;
          setBusy(mode);
          setMessage(null);
          fetch("/dsh-ctx-trim/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId, mode }),
          })
            .then((response) => response.json())
            .then((data) => {
              setBusy("");
              if (data && data.ok) {
                setMessage({ kind: "ok", text: data.message || t("done") });
                setInfo(null);
                setLoadError("");
                // 压完再读一次状态，数字要对得上。
                setTick((value) => value + 1);
                return;
              }
              setMessage({ kind: "err", text: (data && data.message) || t("failed") });
            })
            .catch((error) => {
              setBusy("");
              setMessage({ kind: "err", text: String((error && error.message) || error) });
            });
        }

        function option(key, mode) {
          const plan = info && info.modes && info.modes[mode];
          const line =
            plan && !plan.error
              ? `切掉 ${plan.cutNodes} 条 · 约 ${formatTokens(plan.cutTokens)} token`
              : plan && plan.error
                ? plan.error
                : "";
          return h(
            "button",
            {
              type: "button",
              style: T.card,
              disabled: Boolean(busy),
              onClick: () => run(mode),
            },
            h("span", { style: T.cardName }, busy === mode ? `${t(key)} ${t("working")}` : t(key)),
            h("span", { style: T.cardDesc }, t(key + "Desc")),
            line ? h("span", { style: T.meter }, line) : null,
          );
        }

        const meter =
          info && info.ok
            ? `${t("now")} ${info.nodes} ${t("items")} · ${formatTokens(info.tokens)} token`
            : loadError || t("loading");

        return h(
          "span",
          { ref: wrapRef, style: T.wrap },
          h(
            "button",
            {
              type: "button",
              style: T.trigger,
              title: t("title"),
              onClick: () => setOpen(!open),
            },
            h("span", { style: T.dot }),
            t("button"),
          ),
          open
            ? h(
                "div",
                { style: T.panel },
                h("div", { style: T.head }, h("span", { style: T.title }, t("title")), h("span", { style: T.sub }, t("sub"))),
                h("div", { style: T.meter }, meter),
                option("normal", "normal"),
                option("deep", "deep"),
                message ? h("div", { style: message.kind === "ok" ? T.ok : T.err }, message.text) : null,
                h("div", { style: T.note }, t("hint")),
                h("div", { style: T.foot }, h("button", { type: "button", style: T.close, onClick: () => setOpen(false) }, t("close"))),
              )
            : null,
        );
      };
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ctx-trim: 词典");
        const t = ctx.locale.bind(NS);
        const TrimButton = makeButton(t);
        const render = (props) => h(TrimButton, { sessionId: props.sessionId, key: props.sessionId });
        ctx.slots.inject("conversation.session.header.actions", () =>
          ctx.slots.register({ name: "conversation.session.header.actions", id: "ctx-trim", order: 45 }, render),
        );
      },
    };
  },
});
