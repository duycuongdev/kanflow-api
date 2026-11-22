/**
 * Integration test: Schedules (bảng lịch cá nhân)
 * - CRUD đầy đủ: tạo → xem range → sửa → xóa (soft delete)
 * - Ownership: user khác KHÔNG sửa/xóa được entry của mình (404 - không lộ tồn tại)
 * - Validation: endAt <= startAt, span > 24h, thiếu title → 422
 * Chạy: npm run build && npm run test:e2e
 */
const { test, describe, before, after } = require('node:test')
const { hasDbConfig, startServer, stopServer, api, signToken, pickBoardAndOutsider, getDb, NM } = require('./helpers.js')

const MINUTE = 60 * 1000
let ctx = null
let ownerToken = null
let outsiderToken = null
let createdEntryId = null

const d = hasDbConfig ? describe : describe.skip
const _suite = d('Schedules', () => {
  before(async () => {
    await startServer()
    ctx = await pickBoardAndOutsider()
    if (!ctx) throw new Error('No suitable board+outsider found in DB for testing')
    ownerToken = signToken({ _id: ctx.owner._id.toString(), email: ctx.owner.email }, 'ACCESS_TOKEN_SECRET_SIGNATURE')
    outsiderToken = signToken({ _id: ctx.outsider._id.toString(), email: ctx.outsider.email }, 'ACCESS_TOKEN_SECRET_SIGNATURE')
  })

  after(async () => {
    // Dọn dữ liệu test đã insert (hard delete)
    if (createdEntryId) {
      const { ObjectId } = require(NM + 'mongodb')
      const { db, client } = await getDb()
      await db.collection('schedules').deleteMany({ _id: new ObjectId(createdEntryId) })
      await client.close()
    }
    stopServer()
    if (ctx?.cleanup) await ctx.cleanup()
  })

  test('POST tạo entry hợp lệ -> 201 + đúng userId', async () => {
    const now = Date.now()
    const res = await api('POST', '/schedules', {
      title: 'Test entry: ôn JWT',
      description: 'Đọc lại flow refresh token',
      startAt: now + 60 * MINUTE,
      endAt: now + 120 * MINUTE,
      colorKey: 'green'
    }, ownerToken)

    assertEqual(res.status, 201, 'POST valid entry')
    if (res.data.userId !== ctx.owner._id.toString()) throw new Error('entry.userId mismatch')
    if (res.data.title !== 'Test entry: ôn JWT') throw new Error('entry.title mismatch')
    createdEntryId = res.data._id
  })

  test('POST thiếu title -> 422', async () => {
    const now = Date.now()
    const res = await api('POST', '/schedules', { startAt: now, endAt: now + MINUTE }, ownerToken)
    assertEqual(res.status, 422, 'POST without title')
  })

  test('POST endAt <= startAt -> 422', async () => {
    const now = Date.now()
    const res = await api('POST', '/schedules', { title: 'Sai giờ', startAt: now + MINUTE, endAt: now }, ownerToken)
    assertEqual(res.status, 422, 'POST endAt <= startAt')
  })

  test('POST span > 24h -> 422', async () => {
    const now = Date.now()
    const res = await api('POST', '/schedules', {
      title: 'Quá dài',
      startAt: now,
      endAt: now + 25 * 60 * MINUTE
    }, ownerToken)
    assertEqual(res.status, 422, 'POST span > 24h')
  })

  test('GET range -> có entry vừa tạo', async () => {
    const now = Date.now()
    const res = await api('GET', `/schedules?from=${now}&to=${now + 3 * 60 * MINUTE}`, {}, ownerToken)
    assertEqual(res.status, 200, 'GET range')
    if (!Array.isArray(res.data)) throw new Error('GET /schedules must return an array')
    const found = res.data.some(e => e._id === createdEntryId)
    if (!found) throw new Error('Created entry not found in range query')
  })

  test('PUT sửa entry bởi chủ nhân -> 200 + title mới', async () => {
    const res = await api('PUT', `/schedules/${createdEntryId}`, { title: 'Test entry: đã sửa' }, ownerToken)
    assertEqual(res.status, 200, 'PUT entry by owner')
    if (res.data.title !== 'Test entry: đã sửa') throw new Error('PUT did not apply new title')
  })

  test('PUT sửa entry bởi người khác -> 404 (không lộ tồn tại)', async () => {
    const res = await api('PUT', `/schedules/${createdEntryId}`, { title: 'Hack entry' }, outsiderToken)
    assertEqual(res.status, 404, 'PUT entry by outsider')
  })

  test('DELETE entry bởi người khác -> 404', async () => {
    const res = await api('DELETE', `/schedules/${createdEntryId}`, {}, outsiderToken)
    assertEqual(res.status, 404, 'DELETE entry by outsider')
  })

  test('DELETE entry bởi chủ nhân -> 200 + GET range không còn thấy', async () => {
    const now = Date.now()
    const res = await api('DELETE', `/schedules/${createdEntryId}`, {}, ownerToken)
    assertEqual(res.status, 200, 'DELETE entry by owner')

    const listRes = await api('GET', `/schedules?from=${now}&to=${now + 3 * 60 * MINUTE}`, {}, ownerToken)
    const stillThere = listRes.data.some(e => e._id === createdEntryId)
    if (stillThere) throw new Error('Soft-deleted entry still returned in range query')
  })

  test('GET range không có token -> 401', async () => {
    const res = await api('GET', '/schedules?from=1&to=2', {})
    assertEqual(res.status, 401, 'GET schedules without token')
  })
})

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`FAILED: ${label} - expected ${expected}, got ${actual}`)
}
