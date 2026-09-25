# pi-web-search

pi 扩展：网络搜索（抗限流版）。

## 策略

1. 配置了搜索 API Key 时优先走 API，不爬页面：`TAVILY_API_KEY` / `SERPER_API_KEY` / `BRAVE_API_KEY`。
2. 未配置 Key 时多引擎降级：Bing → DuckDuckGo → Sogou → 360 → Baidu。
3. 单引擎被限流只冷却该引擎（指数退避 2→4→8→15 分钟），不影响其他引擎。
4. 请求串行 + 最小间隔 + UA 轮换 + 429/503 重试 + 结果缓存 + 失败负缓存。

## 安装

复制 `web-search.ts` 到 pi 扩展目录：

```bash
cp web-search.ts ~/.pi/agent/extensions/web-search.ts
# Windows 默认: D:\pihub\.pi\agent\extensions\
```

然后 `/reload`。

## 用法

- LLM 工具：`web_search(query, count?)`（`count` 默认 3，最多 8）
- 命令：`/search <关键词>`

需要可访问公网。设置任一环境变量即可启用 API 通道，例如 `TAVILY_API_KEY=...`。
