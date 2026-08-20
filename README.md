# dsh-elegent-balance-tracker

[![npm version](https://img.shields.io/npm/v/dsh-elegent-balance-tracker?style=flat-square)](https://www.npmjs.com/package/dsh-elegent-balance-tracker)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-plugin-4176E6?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

**DeepSeek Harness (`dsh`) 计费插件**：**当前会话成本** + **官方账户余额**，两个数字都按 DeepSeek 官方计价/接口展示。

## 功能

| 位置 | 内容 | 说明 |
|---|---|---|
| 输入框统计行下方 | **费用: x.xx元** | 当前会话累计成本。host 端逐条读取会话日志的 `usage`（未命中输入 / 缓存命中 / 输出 token），按**每条消息的发生时刻**（北京时间）选择官方**高峰/空闲**价计算，与官方账单口径一致；模型回复完毕即刷新，15s 轮询兜底 |
| 侧边栏底部（设置按钮同行、右对齐） | **余额: x.xx元** | 启动时获取官方准确余额，之后**每分钟自动对齐**官方 `GET /user/balance`；两次对齐之间按本机所有会话**新增成本**实时扣减生成预估余额。点击立即同步；悬停显示余额与上次对齐时间 |

- 计费：token 取自会话日志中 provider 上报的 `usage`（缓存命中拆分、失败重试计入），单价内置官方价格，2026-08-17 起自动按北京时间峰谷价（高峰 9-12 / 14-18 点，空闲半价）。
- 纯本机：余额只请求官方接口（API Key 不出服务器），会话日志只在本地解析，不上报任何外部服务。
- 子代理是独立会话，各自单独统计。
- 累计充值 / 累计消费：官方 API 不提供（`/user/balance` 只有当前余额构成），因此不展示。

## 安装

```sh
# npm 渠道（推荐，适用于所有设备）
dsh plugin --profile web add dsh-elegent-balance-tracker
```

### 离线安装包

```sh
# 方式一：直接指定 tgz 离线包
dsh plugin --profile web add /path/to/dsh-elegent-balance-tracker-0.1.0.tgz

# 方式二：本地目录
dsh plugin --profile web add /absolute/path/to/dsh-elegent-balance-tracker
```

安装后**重启 `dsh web`**（插件行与客户端 bundle 在启动时扫描），再刷新浏览器页面（F5）。

宿主侧 API Key 使用 `DEEPSEEK_API_KEY` 凭据引用（在 Web 模型设置页保存即可），也可回退到同名环境变量。

## 配置（全部可选）

在 web profile 的 `cordis.patch.yml` 覆盖（`$DSH_HOME/profiles/web/cordis.patch.yml`）：

```yaml
- patch:
    - id: dsh-elegent-balance-tracker
      config:
        apiKeyRef: DEEPSEEK_API_KEY   # 余额查询用的凭据引用
        baseURL: ""                   # 余额接口地址；留空用 $DEEPSEEK_BASE_URL，再回退 https://api.deepseek.com
        balanceCacheMs: 60000         # 余额缓存毫秒数
        costCacheMs: 2000             # 会话费用缓存毫秒数
        # 单价覆盖（元 / 百万 tokens）——优先级高于内置默认价
        prices:
          deepseek-v4-flash: { input: 1, cacheRead: 0.02, output: 2 }
        # 日期生效的峰谷价表
        priceSchedule:
          - from: "2026-08-17"
            peak:
              deepseek-v4-flash: { input: 3, cacheRead: 0.1, output: 9 }
            idle:
              deepseek-v4-flash: { input: 1.5, cacheRead: 0.05, output: 4.5 }
```

内置默认价（官方现行价，2026-08-17 起）：

| 模型 | 时段 | 未命中输入 | 缓存命中 | 输出 |
|---|---|---|---|---|
| `deepseek-v4-flash` | 高峰 | ¥3.0/M | ¥0.10/M | ¥9.0/M |
| `deepseek-v4-flash` | 空闲 | ¥1.5/M | ¥0.05/M | ¥4.5/M |
| `deepseek-v4-pro` | 高峰 | ¥9.0/M | ¥0.30/M | ¥27.0/M |
| `deepseek-v4-pro` | 空闲 | ¥4.5/M | ¥0.15/M | ¥13.5/M |

## 卸载

```sh
dsh plugin --profile web remove dsh-elegent-balance-tracker
```

## License

MIT
