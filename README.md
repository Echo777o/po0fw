# po0fw

po0 防火墙自动加白 —— PC（Linux / macOS / Windows）、安卓 Termux、软路由（OpenWrt / Kwrt）通用版。

> 灵感来自群友的 iOS 客户端脚本（Surge / Loon / Stash / QX / Shadowrocket / Egern），本项目把同样的加白逻辑带到桌面与路由器平台。

## 原理

- 每 10 分钟（+ 网络切换事件）探测本机 IPv4 出口
- 先查 `status`：出口所在 `/24` 已在白名单则**跳过**（不推进服务端 FIFO 淘汰队列）
- 不在才调 `add` 加白；支持 `@槽位` 固定坑位
- 多台 po0 机器：多个 token 用英文逗号分割

Token 在 po0 控制台机器详情页「防火墙」卡片获取，形如 `pgnfw_...`。**token 即加白凭证，请勿公开分享。**

## 安装

### Linux / macOS / 安卓 Termux

```sh
curl -sSL https://raw.githubusercontent.com/kelenetwork/po0fw/main/install-linux.sh | PO0FW_TOKENS="pgnfw_你的token" sh
```

- Linux(root)：装为 systemd timer（`po0fw.timer`，每 10 分钟）
- macOS / 非 root：写入 crontab
- Termux：自动装 cronie 并写 crontab（需 `sv-enable crond`）

### OpenWrt / Kwrt 软路由

```sh
curl -sSL https://raw.githubusercontent.com/kelenetwork/po0fw/main/openwrt/install-openwrt.sh -o /tmp/i.sh
PO0FW_TOKENS="pgnfw_你的token" sh /tmp/i.sh
```

- cron 每 10 分钟兜底 + `hotplug.d/iface` WAN 变化即时触发（PPPoE 重拨秒级加白）

### Windows

管理员 PowerShell：

```powershell
irm https://raw.githubusercontent.com/kelenetwork/po0fw/main/windows/install-windows.ps1 -OutFile i.ps1
powershell -ExecutionPolicy Bypass -File i.ps1 -Tokens "pgnfw_你的token"
```

- 注册计划任务：每 10 分钟 + 网络连接事件（EventID 10000）双触发

## 用法

```sh
po0fw                          # 检查并按需加白（读 /etc/po0fw.conf）
po0fw status                   # 只看白名单状态
po0fw pgnfw_xxx,pgnfw_yyy@0    # 临时指定 token；@0 = 固定 0 号槽位
```

多 token：`pgnfw_aaa,pgnfw_bbb`；固定槽位：`pgnfw_aaa@0`（常驻不被淘汰，换槽前先在面板删旧槽）。

## 配置

| 位置 | 说明 |
|---|---|
| `/etc/po0fw.conf` | `PO0FW_TOKENS="pgnfw_xxx"`（Linux/OpenWrt） |
| `%ProgramData%\po0fw\po0fw.conf` | Windows，纯 token 串 |
| 环境变量 `PO0FW_TOKENS` | 优先级最高（低于命令行参数） |

## FAQ

**走代理会把代理 IP 加白吗？** 出口探测请求强制 IPv4 直连公共 IP 源（`ip.sb` / `icanhazip` / `ipify` 三源兜底）；若代理接管全局 TCP，请把这三个域名与 `console.po0.io` 设为直连。

**IPv6？** po0 防火墙按 IPv4 /24 加白，脚本强制 `-4`。

**白名单满了？** 服务端按写入时间 FIFO 淘汰，被挤出的设备最迟 10 分钟自动补回。

## License

MIT
