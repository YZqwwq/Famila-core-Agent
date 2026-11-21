const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createLivingTools, livingToolOptions } = require('../dist/runtime/hdsi/livingTools')
const ctx = () => ({ signal: new AbortController().signal, idempotencyKey: 'test' })
const response = value => new Response(JSON.stringify(value), { status: 200 })

test('living tools: grounded dated forecast, source URL, invalid date and service failure', async () => {
  let calls = 0
  const tools = createLivingTools({ fetch: async url => {
    calls++
    if (url.includes('geocoding')) return response({ results: [{ name: '杭州', latitude: 30.27, longitude: 120.15, admin1: '浙江', country: '中国' }] })
    return response({ daily: { time: ['2026-11-15', '2026-11-16'], weather_code: [0, 61], temperature_2m_min: [12, 11], temperature_2m_max: [20, 18], precipitation_probability_max: [0, 80] } })
  } })
  const weather = tools.find(t => t.name === '查询天气')
  const result = await weather.execute({ '城市': '杭州', '日期': '明天' }, ctx())
  assert.equal(result.ok, true)
  assert.equal(result.days.length, 1)
  assert.equal(result.days[0].date, '2026-11-16')
  assert.equal(result.days[0].rainProbabilityPercent, 80)
  assert.match(result.source, /^https:\/\/api.open-meteo.com/)
  assert.equal((await weather.execute({ '城市': '杭州', '日期': '2027-01-01' }, ctx())).ok, false)
  const before = calls
  assert.equal((await weather.execute({ '城市': '', '日期': '明天' }, ctx())).ok, false)
  assert.equal(calls, before)
  const failing = createLivingTools({ fetch: async () => { throw Error('offline') } })[0]
  assert.equal((await failing.execute({ '城市': '杭州', '日期': '明天' }, ctx())).ok, false)
  assert.match(weather.validateReply({ userMessage: '查一下明天天气', reply: '明天晴天，20度。', observations: [] }), /没有成功/)
  assert.equal(weather.validateReply({ userMessage: '查一下明天天气', reply: '现在查不到，没法确认。', observations: [{ tool: '查询天气', result: { ok: false } }] }), undefined)
})

test('living tools: ambiguous city requires clarification; search requires real sources and keeps credentials host-side', async () => {
  const ambiguous = createLivingTools({ fetch: async () => response({ results: [
    { name: 'Springfield', latitude: 1, longitude: 2, admin1: 'A' }, { name: 'Springfield', latitude: 3, longitude: 4, admin1: 'B' }
  ] }) })[0]
  assert.equal((await ambiguous.execute({ '城市': 'Springfield', '日期': '今天' }, ctx())).ok, false)
  const regional = createLivingTools({ fetch: async url => url.includes('geocoding') ? response({ results: [
    { name: '杭州', latitude: 1, longitude: 2, admin1: '四川' }, { name: '杭州', latitude: 3, longitude: 4, admin1: '浙江' }
  ] }) : response({ daily: { time: ['2026-11-15'], weather_code: [45] } }) })[0]
  assert.equal((await regional.execute({ '城市': '杭州，浙江省', '日期': '今天' }, ctx())).place.region, '浙江')
  let count = 0
  const absent = createLivingTools({ fetch: async () => { count++; throw Error('must not run') } })[1]
  assert.equal((await absent.execute({ '问题': '西红柿鸡蛋面做法' }, ctx())).ok, false)
  assert.equal(count, 0)
  const search = createLivingTools({ searchKey: 'local-test-key', fetch: async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer local-test-key')
    const body = JSON.parse(options.body)
    assert.equal(body.parameters.search_options.forced_search, true)
    assert.ok(!body.input.messages.some(m => m.content.includes('local-test-key')))
    return response({ output: { choices: [{ message: { content: '煮面后卧蛋。' } }], search_info: { search_results: [{ title: '菜谱', link: 'https://example.com/recipe' }] } } })
  } })[1]
  const result = await search.execute({ '问题': '西红柿鸡蛋面做法' }, ctx())
  assert.equal(result.ok, true)
  assert.equal(result.sources[0].url, 'https://example.com/recipe')
  assert.match(search.validateReply({ userMessage: '帮我联网查一下做法', reply: '先烧水。', observations: [] }), /尚未收到/)
  assert.equal(search.validateReply({ userMessage: '帮我联网查一下做法', reply: '先烧水。', observations: [{ tool: '搜索公开信息', result }] }), undefined)
  const noSources = createLivingTools({ searchKey: 'key', fetch: async () => response({ output: { choices: [{ message: { content: '无依据答案' } }] } }) })[1]
  assert.equal((await noSources.execute({ '问题': '查询' }, ctx())).ok, false)
  assert.equal(livingToolOptions({ baseURL: 'https://example.com', modelKey: 'other-provider-key' }).searchKey, process.env.DASHSCOPE_API_KEY?.trim() || undefined)
})

test('wttr forecast: selected local date, 3-hour evidence, tonight filtering, range and wrong-location rejection', async () => {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
  const tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
  const mock = async url => url.includes('geocoding') ? response({ results: [{ name: '杭州', latitude: 30.29, longitude: 120.16, admin1: '浙江', timezone: 'Asia/Shanghai' }] }) : response({
    nearest_area: [{ latitude: '30.29', longitude: '120.16', areaName: [{ value: 'Hangzhou' }] }],
    weather: [today, tomorrow].map(date => ({ date, mintempC: '11', maxtempC: '20', hourly: [
      { time: '600', tempC: '12', chanceofrain: '20', lang_zh: [{ value: '多云' }] },
      { time: '1800', tempC: '16', chanceofrain: '50', weatherDesc: [{ value: 'Light rain' }] }
    ] }))
  })
  const weather = createLivingTools({ weatherProvider: 'wttr', fetch: mock })[0]
  const result = await weather.execute({ '城市': '杭州，浙江', '日期': '明天' }, ctx())
  assert.equal(result.ok, true)
  assert.equal(result.provider, 'wttr.in')
  assert.match(result.source, /wttr.in\/30.2900,120.1600/)
  assert.equal(result.days[0].date, tomorrow)
  assert.equal(result.days[0].hourly[0].time, '06:00')
  assert.equal(result.days[0].hourly[0].description, '多云')
  assert.equal(result.days[0].minC, 11)
  const night = await weather.execute({ '城市': '杭州，浙江', '日期': '今晚' }, ctx())
  assert.deepEqual(night.days[0].hourly.map(h => h.time), ['18:00'])
  assert.equal((await weather.execute({ '城市': '杭州', '日期': '2099-01-01' }, ctx())).ok, false)
  const misplaced = createLivingTools({ weatherProvider: 'wttr', fetch: async url => url.includes('geocoding') ? mock(url) : response({ nearest_area: [{ latitude: '40', longitude: '116' }], weather: [] }) })[0]
  assert.equal((await misplaced.execute({ '城市': '杭州', '日期': '明天' }, ctx())).ok, false)
})
