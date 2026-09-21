# pi-web-search

pi 扩展：网络搜索。主用 Bing，被限流自动切 Sogou；cookie 预热 + 请求串行限速 + 结果缓存。

## 安装

```bash
cp web-search.ts ~/.pi/agent/extensions/web-search.ts
```

然后 `/reload`。

## 用法

- LLM 工具：`web_search(query, count?)`
- 命令：`/search <关键词>`

需要可访问公网。
