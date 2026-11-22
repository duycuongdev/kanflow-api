import express from 'express'
import { scheduleValidation } from '~/validations/scheduleValidation'
import { scheduleController } from '~/controllers/scheduleController'
import { authMiddleware } from '~/middlewares/authMiddleware'

const Router = express.Router()

// Danh sách entry lịch của user trong khoảng from/to (epoch ms) - dùng cho view tuần/tháng
Router.route('/')
  .get(authMiddleware.isAuthorized, scheduleValidation.rangeQuery, scheduleController.getEntriesInRange)
  .post(authMiddleware.isAuthorized, scheduleValidation.createNew, scheduleController.createNewEntry)

Router.route('/:entryId')
  .put(authMiddleware.isAuthorized, scheduleValidation.updateEntry, scheduleController.updateEntry)
  .delete(authMiddleware.isAuthorized, scheduleValidation.deleteEntry, scheduleController.deleteEntry)

export const scheduleRoute = Router
