/**
 * Socket cho tính năng Bảng lịch cá nhân (Schedule)
 * - Không cần handler FE_* mới: user đã tự join phòng cá nhân (room = userId)
 *   qua sự kiện FE_USER_JOIN_ROOM có sẵn trong inviteUserToBoardSocket
 * - Module này chỉ dùng để service layer bắn thay đổi lịch tới mọi socket
 *   của 1 user (đồng bộ đa thiết bị: tạo trên máy này, máy khác thấy ngay)
 */

// io instance được server.js đăng ký sau khi khởi tạo
let ioInstance = null
export const setScheduleSocketServerInstance = (io) => {
  ioInstance = io
}

export const SCHEDULE_ACTION_TYPES = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE'
}

/**
 * Bắn 1 thay đổi lịch tới phòng cá nhân của user (room = userId).
 * payload: { actionType: 'CREATE'|'UPDATE'|'DELETE', entry }
 */
export const emitScheduleChangeToUser = (userId, payload) => {
  if (!ioInstance || !userId || !payload?.actionType) return
  ioInstance.to(userId.toString()).emit('BE_SCHEDULE_CHANGED', payload)
}
