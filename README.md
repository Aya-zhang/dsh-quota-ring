# dsh-quota-ring · DSH 余额环

在 DSH 侧边栏左下角显示 **余额**、**今日花费** 和 **峰谷计价圆环**。

![截图](docs/screenshot.png)

> 截图放 `docs/screenshot.png`；没有就删掉上面这行。

## 功能

| 功能 | 说明 |
|---|---|
| 余额 | 从 DeepSeek 平台读取真实余额 |
| 今日花费 | 扫描本机会话日志，按内置价目表估算 |
| 峰谷圆环 | 按「今日高峰花费 / 闲时花费」的比例分色 |
| 悬停 | 高峰花费、闲时花费、Token 数、缓存命中率、请求数、距下次峰谷切换还有多久 |
| 单击 | 刷新余额 |
| 点圆环 | 重启 DSH（改完插件代码后免手动重启） |

圆环颜色：

| 状态 | 颜色 |
|---|---|
| 高峰时段 | 琥珀 `#ffb020` |
| 闲时时段 | 灰绿 `#6FAE86` |
| 余额 < ¥3 | 红色 `#ff5c7a` + 呼吸闪烁 |

## 安装

```bash
git clone https://github.com/Aya-zhang/dsh-quota-ring.git ~/.dsh/plugins/dsh-quota-ring
ln -s ~/.dsh/plugins/dsh-quota-ring ~/.dsh/profiles/desktop/node_modules/dsh-quota-ring
```

再编辑 `~/.dsh/profiles/desktop/package.json`，两处加上：

```json
{
  "dependencies": {
    "dsh-quota-ring": "link:/Users/你的用户名/.dsh/plugins/dsh-quota-ring"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-quota-ring"]
    }
  }
}
```

重启 DSH 生效。

## 数据来源与隐私

- **余额**：调用 DeepSeek 官方余额接口
- **今日花费**：读取本机 DSH 会话日志（`~/.dsh/`），按内置价目表计算
- **网络**：只访问 `api.deepseek.com` 与 `platform.deepseek.com`
- **凭据**：读取本机已保存的 API Key / User Token，**不发送给任何第三方**
- 不上报、不统计、不联网存储任何数据

## 已知限制

1. **依赖侧边栏类名** —— 为了把徽章移到账户名右侧，CSS 用了 `[class*="footArea"]` 这类选择器。DSH 更新后若改类名，徽章会退回「独占一行」（不会崩溃）。
2. **布局按 260px 侧边栏调校** —— 侧边栏宽度不同时，位置可能需要微调。
3. **价格表固定写在代码里** —— 官方调价后估算会不准，需手动更新 `lib/index.js` 的 `PRICING`。
4. **点圆环会重启应用** —— 破坏性操作，会中断当前会话。
5. **余额与今日不会严格同步** —— 余额是接口真实值（2 位小数），今日是本地估算（4 位小数），数据源不同。这是设计如此，不是 bug。

## 自定义

配色和位置都在 `lib/client.js`，改数字即可：

| 想改什么 | 行号 | 当前值 |
|---|---|---|
| 圆环「闲时」色 | 162、163 | `#6FAE86` |
| 圆环「高峰」色 | 161、163 | `#ffb020` |
| 低余额红色 | 161、163 | `#ff5c7a` |
| 数字上涨色 | 41、45 | `#96C6A9` |
| 数字下跌色 | 42、46 | `#ff8fa3` |
| 今日花费上涨色 | 43 | `#ffb020` |
| 悬停底色 | 27 | `rgba(255,255,255,0.17)` |
| 弹层背景 | 49 | `#26282D` |
| 弹层宽度 | 18 与 49 | `232`（两处必须一致） |
| 徽章垂直位置 | 64 | `bottom:4px`（调大＝上移） |

改完点一下圆环重启，就能看到效果。

## 许可

MIT
