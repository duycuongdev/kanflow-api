/**
 * Integration test: Focus Sessions (thống kê focus + bảng xếp hạng)
 * - POST phiên focus hợp lệ/lệ → 201/422
 * - GET stats → tổng durationMs đúng (= dữ liệu có sẵn trong range + những gì test vừa insert)
 * - GET leaderboard → có user hiện tại, hạng tính đúng theo tổng focus
 * Chạy: npm run build && npm run test:e2e
 */
const { test, describe, before, after } = require('node:test')
const { hasDbConfig, startServer, stopServer, api, signToken, pickBoardAndOutsider, getDb, NM } = require('./helpers.js')

const MINUTE = 60 * 1000
let ctx = null
let token = null
const createdSessionIds = []

const d = hasDbConfig ? describe : describe.skip
const _suite = d('Focus Sessions', () => {
  before(async () => {
    await startServer()
    ctx = await pickBoardAndOutsider()
    if (!ctx) throw new Error('No suitable board+outsider found in DB for testing')
    token = signToken({ _id: ctx.owner._id.toString(), email: ctx.owner.email }, 'ACCESS_TOKEN_SECRET_SIGNATURE')
  })

  after(async () => {
    // Dọn dữ liệu test đã insert để không làm nhiễu leaderboard của DB thật
    if (createdSessionIds.length > 0) {
      const { ObjectId } = require(NM + 'mongodb')
      const { db, client } = await getDb()
      await db.collection('focus_sessions').deleteMany({ _id: { $in: createdSessionIds.map(id => new ObjectId(id)) } })
      await client.close()
    }
    stopServer()
    if (ctx?.cleanup) await ctx.cleanup()
  })

  test('POST phiên focus hợp lệ (25 phút) -> 201 + durationMs đúng', async () => {
    const now = Date.now()
    const res = await api('POST', '/focus-sessions', { startedAt: now - 30 * MINUTE, endedAt: now - 5 * MINUTE }, token)
    assertEqual(res.status, 201, 'POST valid focus session')
    if (res.data.durationMs !== 25 * MINUTE) throw new Error(`durationMs expected ${25 * MINUTE}, got ${res.data.durationMs}`)
    createdSessionIds.push(res.data._id)
  })

  test('POST phiên < 1 phút -> 422', async () => {
    const now = Date.now()
    const res = await api('POST', '/focus-sessions', { startedAt: now - 30 * 1000, endedAt: now }, token)
    assertEqual(res.status, 422, 'POST too-short session')
  })

  test('POST phiên > 4 giờ -> 422', async () => {
    const now = Date.now()
    const res = await api('POST', '/focus-sessions', { startedAt: now - 5 * 60 * MINUTE, endedAt: now }, token)
    assertEqual(res.status, 422, 'POST too-long session')
  })

  test('POST endedAt <= startedAt -> 422', async () => {
    const now = Date.now()
    const res = await api('POST', '/focus-sessions', { startedAt: now, endedAt: now - MINUTE }, token)
    assertEqual(res.status, 422, 'POST endedAt <= startedAt')
  })

  test('GET stats -> tổng durationMs = dữ liệu cũ + dữ liệu test vừa insert', async () => {
    const now = Date.now()
    const from = now - 3 * 60 * MINUTE
    const to = now + 5 * MINUTE

    // Insert thêm 1 phiên 10 phút để cộng dồn
    const created = await api('POST', '/focus-sessions', { startedAt: now - 20 * MINUTE, endedAt: now - 10 * MINUTE }, token)
    assertEqual(created.status, 201, 'POST session for stats')
    createdSessionIds.push(created.data._id)

    // Tổng focus có sẵn của user trong range (tính trực tiếp từ DB)
    const { ObjectId } = require(NM + 'mongodb')
    const { db, client } = await getDb()
    const agg = await db.collection('focus_sessions').aggregate([
      { $match: { userId: new ObjectId(ctx.owner._id.toString()), _destroy: { $ne: true }, startedAt: { $gte: new Date(from), $lt: new Date(to) } } },
      { $group: { _id: null, totalMs: { $sum: '$durationMs' } } }
    ]).toArray()
    await client.close()
    const expectedTotal = agg[0]?.totalMs || 0

    const res = await api('GET', `/focus-sessions/stats?from=${from}&to=${to}`, {}, token)
    assertEqual(res.status, 200, 'GET stats')
    if (res.data.totalMs !== expectedTotal) throw new Error(`stats.totalMs expected ${expectedTotal}, got ${res.data.totalMs}`)
    if (res.data.sessionCount < 2) throw new Error(`sessionCount expected >= 2, got ${res.data.sessionCount}`)
  })

  test('GET leaderboard -> có "me" với tổng đúng, rank khớp số user cao hơn', async () => {
    const now = Date.now()
    const from = now - 3 * 60 * MINUTE
    const to = now + 5 * MINUTE

    const res = await api('GET', `/focus-sessions/leaderboard?from=${from}&to=${to}`, {}, token)
    assertEqual(res.status, 200, 'GET leaderboard')

    if (!res.data.me || res.data.me.userId !== ctx.owner._id.toString()) throw new Error('leaderboard.me missing or wrong user')
    if (res.data.me.totalMs <= 0) throw new Error('leaderboard.me.totalMs should be > 0 after inserting sessions')
    if (!Array.isArray(res.data.top) || res.data.top.length === 0) throw new Error('leaderboard.top should not be empty')

    // Rank của "me" phải bằng số user có tổng cao hơn + 1
    const higherCount = res.data.top.filter(row => row.totalMs > res.data.me.totalMs).length
    if (res.data.me.rank !== higherCount + 1) {
      throw new Error(`rank expected ${higherCount + 1} (chỉ xét trong top), got ${res.data.me.rank}`)
    }

    // Top phải sắp xếp giảm dần
    for (let i = 1; i < res.data.top.length; i++) {
      if (res.data.top[i - 1].totalMs < res.data.top[i].totalMs) throw new Error('leaderboard.top is not sorted descending')
    }
  })

  test('GET stats không có token -> 401', async () => {
    const res = await api('GET', '/focus-sessions/stats?from=1&to=2', {})
    assertEqual(res.status, 401, 'GET stats without token')
  })
})

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`FAILED: ${label} - expected ${expected}, got ${actual}`)
}
