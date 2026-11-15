import { GET_DB } from '~/config/mongodb'

/**
 * Kiểm tra xem lỗi có phải do xung đột ghi đồng thời (WriteConflict) hoặc lỗi tạm thời không
 */
export const isRetryableTransactionError = (error) => {
  if (!error) return false
  // Mã lỗi 112: WriteConflict trong MongoDB WiredTiger
  if (error.code === 112) return true
  // Thông điệp lỗi chứa Write conflict
  if (typeof error.message === 'string' && error.message.includes('Write conflict')) return true
  // Lỗi có nhãn TransientTransactionError
  if (typeof error.hasErrorLabel === 'function' && error.hasErrorLabel('TransientTransactionError')) return true
  return false
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Chạy các thao tác ĐA-DOCUMENT trong 1 MongoDB transaction (nguyên tố - atomic):
 * - Thành công hết => tự động commit
 * - Bất kỳ thao tác nào lỗi => tự động abort, toàn bộ thay đổi đã thực hiện được ROLLBACK
 *   (tránh dữ liệu mồ côi: card tồn tại nhưng thiếu trong cardOrderIds, board xóa dở, v.v.)
 * - Tự động retry khi gặp xung đột ghi đồng thời (WriteConflict - code 112) hoặc lỗi tạm thời
 *   bằng exponential backoff kèm jitter ngẫu nhiên để giải tán tranh chấp
 *
 * YÊU CẦU: MongoDB phải chạy dưới dạng replica set (MongoDB Atlas mặc định là replica set).
 * Cách dùng:
 *   return await withTransaction(async (session) => {
 *     await modelA.write(..., { session })
 *     await modelB.write(..., { session })
 *     return result
 *   })
 */
export const withTransaction = async (operations, maxRetries = 3) => {
  let attempt = 0
  while (true) {
    attempt++
    const session = GET_DB().client.startSession()
    try {
      let result
      await session.withTransaction(
        async () => {
          result = await operations(session)
        },
        {
          readPreference: 'primary',
          readConcern: { level: 'local' },
          writeConcern: { w: 'majority' }
        }
      )
      return result
    } catch (error) {
      if (isRetryableTransactionError(error) && attempt <= maxRetries) {
        // Exponential backoff kèm jitter (ngẫu nhiên 30-80ms) để giải tán tranh chấp đồng thời
        const backoff = Math.min(50 * Math.pow(2, attempt - 1), 300)
        const jitter = Math.floor(Math.random() * 50) + 30
        await sleep(backoff + jitter)
        continue
      }
      throw error
    } finally {
      await session.endSession()
    }
  }
}

