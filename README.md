# dsh-quota-ring · DSH 余额环

在 **DeepSeek Harness（DSH）侧边栏的账户名旁**，一眼看到 DeepSeek 账户余额、今日预估花费和当前峰闲时段。平时不用打开用量页面；想看明细，鼠标移到数字上即可。

![余额环在 DSH 侧边栏的位置](docs/01-overview.png)

*余额环与账户名在同一行；`余`是平台返回的余额，`今`是根据本机会话日志估算的花费。*

> 适用于 **macOS**。安装需要 Git 和 DSH；插件使用 DSH 自带的 Node 运行，无需额外安装 Node 或 npm 依赖。已在 DSH `0.2.1-rc.3` 验证。
>
> **“今”是估算值，不是 DeepSeek 官方账单。** 它与账户余额来源不同，数值不会严格同步。

## 安装

在终端运行（以下以 `desktop` profile 为例）：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add github:Aya-zhang/dsh-quota-ring#v0.1.0
```

若使用其他 profile，把 `desktop` 换成实际名称。安装命令会把插件加入对应 profile；完成后重启 DSH。插件会读取当前 DSH 已保存的 DeepSeek 登录信息，无需在插件中填写密钥。

<details>
<summary>手动安装（适用于需要修改插件源码的用户）</summary>

1. 克隆插件：

   ```bash
   git clone https://github.com/Aya-zhang/dsh-quota-ring.git ~/.dsh/plugins/dsh-quota-ring
   ```

2. 在 profile 的 `node_modules` 中建立软链：

   ```bash
   ln -s ~/.dsh/plugins/dsh-quota-ring \
         ~/.dsh/profiles/desktop/node_modules/dsh-quota-ring
   ```

3. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾加入：

   ```yaml
   - insert:
       - id: quota-ring
         name: dsh-quota-ring
   ```

4. 重启 DSH。手动安装通过 profile 的补丁层加载。

</details>

## 怎么看

### 两个数字：余额与今日预估

`余:¥9.89` 是 DeepSeek 平台返回的账户余额；`今:¥1.71` 是插件按本机 DSH 会话日志和内置价目表计算的今日预估花费。深色和浅色主题均可显示。

![深色主题下的余额环](docs/02-badge-dark.png)
![浅色主题下的余额环](docs/03-badge-light.png)

### 一个圆环：当前时段与今日花费分布

- **环心**表示当前时段：按插件内置规则，北京时间周一至周五 09:00–12:00、14:00–18:00 为黄色峰时，其余为绿色闲时；法定节假日和调休不特殊处理。
- **环周**黄色和绿色的长度，分别表示今日预估花费中峰时和闲时的占比。环周统计的是**今天**，环心显示的是**此刻**。
- 余额低于阈值时，环心变红并出现红色呼吸光晕。默认阈值是 **¥3**。

峰闲时段和价格来自插件内置规则。平台调整后，插件估算可能与实际费用有差异。

### 悬停看明细，点击做操作

鼠标移到数字上，可以查看今日峰时花费、闲时花费、合计、Token 数、缓存命中率、请求数及距离下次时段切换的时间。面板提供官方用量／充值页面入口。

![深色主题下的今日明细](docs/06-popover-dark.png)
![浅色主题下的今日明细](docs/07-popover-light.png)

点击**数字区域**可手动刷新；插件也会每 **60 秒**自动刷新。圆环和数字是独立点击区域，点击数字不会打开重启弹窗。刷新时圆环显示转动的高亮弧。数值变化会短暂翻动并变色：余额增加为绿、减少为红；今日预估花费增加为黄、减少为红。

![今日预估花费增加时的黄色动效](docs/08-roll-yellow.png)
![余额减少时的红色动效](docs/09-roll-pink.png)

点击**圆环**会打开重启确认弹窗；只有确认后才会重启 DSH。重启会中断当前会话。

![鼠标悬停在圆环上](docs/04-hover-ring.png)
![重启 DSH 的确认弹窗](docs/05-restart.png)

## 调整低余额提醒

默认在余额**低于** ¥3 时提醒。要修改阈值，在 `cordis.patch.yml` 的插件配置里加入 `lowBalance`：

```yaml
- insert:
    - id: quota-ring
      name: dsh-quota-ring
      config:
        lowBalance: 5
```

保存后重启 DSH 生效。正数表示提醒阈值；`0` 表示关闭低余额提醒；负数、非数字或留空时使用默认值 `3`。

## 数据来源与限制

- **余额**来自 DeepSeek 官方账户接口；插件从 DSH 已保存的凭据读取 API Key，必要时使用 User Token 查询官方平台，不向第三方发送凭据。
- **今日预估花费**只读取本机 `~/.dsh/sessions` 中的 DSH 会话日志，并按插件内置价目表计算。其他设备或渠道产生的用量不会出现在这里，也不能把这个数字当作官方账单。
- 插件内置的价格和峰闲时段规则可能随平台调整而过时。
- 侧边栏位置依赖 DSH 当前的页面类名和宽度。DSH 更新或侧边栏宽度变化后，布局可能需要调整。
- 插件不上传统计数据，也不使用第三方遥测服务。

## 测试与许可

仓库自带不启动 DSH、不联网的自测。在**插件仓库目录**运行，使用 DSH 自带的 Node：

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" test/selftest.mjs
```

如果本机另外安装了 Node，也可以运行 `node test/selftest.mjs`。

当前覆盖请求来源校验、峰闲判断、费用计算、低余额阈值及并发刷新，共 **30 项断言**。

许可：MIT。
