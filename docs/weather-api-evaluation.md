# 天气 API 改接与复测

2026-11-15。HDSI 内核不改动，只更换外围天气工具的预报数据源。

## 调研与选择

| API | 接入条件 | 适用能力 | 本轮状态 |
|---|---|---|---|
| [和风天气](https://dev.qweather.com/en/docs/api/weather/) | 专属 API Host，JWT 或 API Key | 城市定位、日预报及逐小时预报 | 本地没有凭据，未实接；[专属域名说明](https://dev.qweather.com/en/docs/configuration/api-host/)、[鉴权说明](https://dev.qweather.com/en/docs/configuration/authentication/) |
| [高德天气](https://lbs.amap.com/api/webservice/guide/api/weatherinfo) | Web 服务 Key、城市 adcode | 实况、未来日夜天气 | 未配置 Key，未实接 |
| [心知天气](https://docs.seniverse.com/product/data/free.html) | 账号与 Key，数据范围依产品 | 国内城市实况、基本未来3天预报、生活指数 | 未配置 Key，未实接 |
| [MET Norway](https://api.met.no/weatherapi/locationforecast/2.0/documentation) | 带应用标识的 User-Agent，按服务要求缓存 | 全球坐标预报，时间序列 | 杭州坐标公开探测 HTTP 200，约1.54秒；未作为本轮正式数据源 |
| [wttr.in](https://github.com/chubin/wttr.in) | 本轮公开 JSON 请求无需专用 Key | 通常未来3天，约3小时分时点 | 杭州探测 HTTP 200，约3.48秒；本轮选择接入 |
| [Open-Meteo](https://open-meteo.com/en/docs) | 现有公开接口无需专用 Key | 全球定位、日预报与小时数据 | 原工具已接日预报；保留为显式可选项 |

本地无天气专用凭据，因此先用已探测可用的 wttr.in 完成真实接入，而不是声称已经接通和风/高德。其公开服务的可用性和预报准确率不能由一次探测证明。若未来采用国内供应商，应使用自己的账号、凭据和对应套餐再验收。

## 改动

- `livingToolOptions` 和 CLI/HTTP 默认选择 `FAMILA_WEATHER_PROVIDER=wttr`，可显式设 `open-meteo` 使用旧预报源。程序化调用可传 `createLivingTools({ weatherProvider: 'wttr' })`；不经配置工厂、直接省略该参数的旧程序保留 Open-Meteo 行为。
- 城市定位仍使用 Open-Meteo，保留省份消歧。wttr 请求使用确定的经纬度，核对其 nearest_area 与目标位置，明显错位时不采用。
- wttr 结果保留来源、访问时间、日期、城市时区、全天最低/最高温度与分时温度、体感、降雨概率、风速和天气描述。今晚仅返回晚间分时点；超出可用日期不拿其他日期冒充。
- 不同预报源不静默混用，失败明确返回；没有加入搜索兜底来伪装天气接口成功。
- 温度范围是全天数据，分时点通常间隔3小时；不能把低降雨概率改写成保证不下雨，也不能把分时点当作分钟级实况。

## 真实复测

执行 `node scripts/living-scenes-live.cjs --scenes=weather,failure`。报告：`evals/companion_zh/reports/living-scenes-1794756475587/results.json`。

1. 浙江杭州出门：工具真实返回 wttr.in 的 2026-11-16 预报，全天 13–19℃；06:00 为13℃、降雨概率17%，09:00 为15℃、概率20%，12:00 为19℃、概率14%。工具连同定位约4.21秒；原生可见首泡“杭州明天13-19度”，整轮约22.42秒。其他信息是否全部投递仍受原生拆泡调度影响，不能只看首泡判为完整回答。
2. 故障：新身份注入不可用天气服务，执行器返回失败。实际回复“刚试了下，天气接口抽风了刷不出数据”，没有编造温度；整轮约19.93秒。原脚本因仅识别“刷不出来”漏判“刷不出数据”，原始 functionalPass=false 保留。人工核对判为失败表达符合场景，已扩展后续脚本识别，不为修正文字判定而追加模型请求。

本次4次主模型调用，输入27,916、输出1,239 token；无联网搜索。公开接口连通探测不调用模型。前后预报温度不同，只代表不同数据源的返回不同，本轮没有实况对照，不判断谁更准确。

构建通过，15项集成测试通过，255个TS文件边界检查通过。新增确定性测试覆盖日期与时区、晚间筛选、分时证据、超范围和错位地点拒绝。`git diff -- vendor/hdsi` 为空。
