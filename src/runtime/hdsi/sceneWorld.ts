import { HdsiDatabase, type Query } from './hdsiDatabase'
// The simulated PC belongs to this HDSI identity. Document names never resolve to host paths.
export const editorActions = [
  { name: '打开文稿', fields: ['标题'], description: '在电脑编辑器打开文稿。新标题是一张空白页，打开过的标题会恢复上次的草稿。' },
  { name: '编辑文稿', fields: ['内容'], description: '把当前页改成给出的完整正文。光标留在编辑器里，改动尚未存盘。' },
  { name: '保存文稿', fields: [], description: '将当前页的正文存盘。' }
]

const inkMark = /【\/?文稿落字/
export function readInlineInk(script: string) {
  if (!inkMark.test(script)) return { script }
  const match = /【文稿落字】([^【】]{1,4000})【\/文稿落字】/.exec(script)
  if (!match || !match[1].trim() || /[<>]/.test(match[1])) throw new Error('一幕只标一次实际追加的纯文本。')
  const before = script.slice(0, match.index)
  const after = script.slice(match.index + match[0].length)
  if (inkMark.test(before + after) || before.lastIndexOf('<say') > before.lastIndexOf('</say>')) {
    throw new Error('落字标记只能放在叙述编辑器动作的位置。')
  }
  return { script: before + match[1] + after, addition: match[1] }
}

export class SceneWorld {
  constructor(private db: HdsiDatabase) {}
  async initialize(query: Query) {
    await query('CREATE TABLE IF NOT EXISTS documents(title TEXT PRIMARY KEY, draft TEXT NOT NULL, saved TEXT)')
    await query('CREATE TABLE IF NOT EXISTS editor(id INTEGER PRIMARY KEY CHECK(id=1), title TEXT NOT NULL)')
    await query('CREATE TABLE IF NOT EXISTS inline_edits(turn TEXT PRIMARY KEY, title TEXT NOT NULL, addition TEXT NOT NULL)')
    await query('CREATE TABLE IF NOT EXISTS weather_page(id INTEGER PRIMARY KEY CHECK(id=1), page TEXT NOT NULL)')
  }
  private async currentDocument(query: Query) {
    return (await query('SELECT d.* FROM editor e JOIN documents d ON d.title=e.title WHERE e.id=1')).rows[0]
  }
  private async editorView(query: Query) {
    const doc = await this.currentDocument(query)
    return doc ? { 标题: doc.title, 正文: doc.draft, 已保存: doc.saved === doc.draft } : null
  }
  async appendInk(turn: string, page: Awaited<ReturnType<SceneWorld['editorView']>>, addition: string) {
    await this.db.transaction(async query => {
      const prior = (await query('SELECT title,addition FROM inline_edits WHERE turn=?', turn)).rows[0]
      if (prior && prior.title === page?.标题 && prior.addition === addition) return
      if (prior) throw new Error('本轮已有不同的落字记录。')
      const doc = await this.currentDocument(query)
      if (!doc || !page || doc.title !== page.标题 || doc.draft !== page.正文) throw new Error('编辑器页面已改变，请重新观察。')
      if (doc.draft.length + addition.length > 20000) throw new Error('文稿过长。')
      await query('UPDATE documents SET draft=draft || ? WHERE title=?', addition, doc.title)
      await query('INSERT INTO inline_edits VALUES (?,?,?)', turn, doc.title, addition)
    })
  }
  view() {
    return this.db.transaction(async query => {
      const weather = (await query('SELECT page FROM weather_page WHERE id=1')).rows[0]
      return { 电脑编辑器: await this.editorView(query), 手机上次打开的天气页: weather ? JSON.parse(weather.page) : null }
    })
  }
  async setWeatherPage(query: Query, city: string, date: string, result: any) {
    const page = { 城市: city, 日期选择: date, 查询时间: new Date().toISOString(),
      页面: result?.ok ? { 地点: result.place?.name, 预报: result.days?.map((d: any) => ({ 日期: d.date, 最低温: d.minC, 最高温: d.maxC })) } : '未取得预报' }
    await query('INSERT INTO weather_page VALUES (1,?) ON CONFLICT(id) DO UPDATE SET page=excluded.page', JSON.stringify(page))
  }
  async act(name: string, fields: Record<string, string>, query?: Query): Promise<any> {
    if (!query) return this.db.transaction(tx => this.act(name, fields, tx))
    if (name === '打开文稿') {
      await query("INSERT INTO documents(title,draft) VALUES (?,'') ON CONFLICT(title) DO NOTHING", fields['标题'])
      await query('INSERT INTO editor VALUES (1,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title', fields['标题'])
    } else {
      const doc = await this.currentDocument(query)
      if (!doc) return { ok: false, 页面: '编辑器还没有打开文稿' }
      if (name === '编辑文稿') await query('UPDATE documents SET draft=? WHERE title=?', fields['内容'], doc.title)
      else if (name === '保存文稿') await query('UPDATE documents SET saved=draft WHERE title=?', doc.title)
      else throw new Error('Unknown editor action')
    }
    return { ok: true, 页面: await this.editorView(query) }
  }
}
