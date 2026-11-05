# dsh-ctx-trim

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的手动上下文压缩：**会话头部一个「上下文」按钮，两档压缩，本地摘要不调模型。**

长会话涨到二十几万 token 以后，自动压缩只会把最后那条消息留下，前面全丢；你想自己决定「切到哪、留多少」，又没有入口。这个插件补的就是那个入口。

![两档](icon.svg)

## 装

```bash
dsh plugin --profile <你的profile> add dsh-ctx-trim
```

装完刷新页面，会话标题右边多一个「上下文」按钮。

## 用

点按钮 → 面板里两行数字 → 点一档 → 等它跑完。

| 档位 | 保留 | 下限 | 多余的动作 |
| --- | --- | --- | --- |
| 正常压缩 | 最近 30% token 的原文 | 至少 6k | — |
| 深度压缩 | 最近 10% token 的原文 | 至少 2.5k | 切下的原文打包进 `~/.dsh/im/ctxpacks/` |

切点两端都收在结构边界上（不切在工具调用中间、不切在压缩标记中间），所以压完的会话还是合法的对话。

## 摘要从哪来

- 优先用同 profile 里 `dsh-live-compact/plan.js` 的本地摘要器（有这个插件就用，没有就跳过）；
- 都没有时用内置摘录：每条留开头、保留硬性条款行；
- **全程不调模型**，所以不花钱、不等生成。

摘要如果没比切掉的原文更小，这次直接放弃不落盘——宁可不动，不给你写一条更长的上下文。

## 它怎么做到「空闲才能压」

走的是 DSH 公开的压缩事务：

```
compaction/start → compaction/summary → user/message(replace) → compaction/end → flush
```

外层套 `agent.runMaintenance`，跟正在跑的回合互斥。所以点的时候如果这一轮还没结束，会明确告诉你「这个会话正在跑…等这一轮结束再压」，不会把日志写坏。

## 限制

- 只在会话**空闲**时能压；回合进行中会被拒绝（这是故意的）。
- 没有撤销按钮。被折叠的原文还在 session log 里，但界面上看不见了。
- 只有 Web 端有按钮；保留比例是写死的两档，暂不支持自定义。
- 不用 `ctx.compaction.compactRegion`：它写死 `owner:'current-turn'`，空闲会话上必抛 `no open turn`。

## 接口

宿主挂了两个路由（客户端用它，你也可以自己 curl）：

```bash
# 看一眼这个会话现在多少条、两档各会切多少
curl "http://<host>:<port>/dsh-ctx-trim/status?sessionId=session-xxx"

# 试跑（不落盘），看会切多少、摘要多大
curl -X POST http://<host>:<port>/dsh-ctx-trim/run \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-xxx","mode":"normal","dry":true}'

# 真压
curl -X POST http://<host>:<port>/dsh-ctx-trim/run \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-xxx","mode":"deep"}'
```

只收 `application/json`，浏览器从别的站发来的跨站请求（`sec-fetch-site: cross-site`）直接 403。

## 兼容

- DSH `>=0.2.0-rc.2 <0.3.0-0`
- Node `>=22.13.0`
- 已实测：DSH 0.2.1-rc.5 + Web profile，真跑一次把 353 条 / 263k token 压到 194 条 / 127.8k token。

## 许可

MIT
