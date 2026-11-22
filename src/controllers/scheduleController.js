import { StatusCodes } from 'http-status-codes'
import { scheduleService } from '~/services/scheduleService'

const createNewEntry = async (req, res, next) => {
  try {
    // User thực hiện request này chính là chủ nhân của entry lịch
    const userId = req.jwtDecoded._id

    const createdEntry = await scheduleService.createNewEntry(req.body, userId)

    res.status(StatusCodes.CREATED).json(createdEntry)
  } catch (error) {
    next(error)
  }
}

const getEntriesInRange = async (req, res, next) => {
  try {
    const userId = req.jwtDecoded._id
    const { from, to } = req.query

    const entries = await scheduleService.getEntriesInRange(userId, Number(from), Number(to))

    res.status(StatusCodes.OK).json(entries)
  } catch (error) {
    next(error)
  }
}

const updateEntry = async (req, res, next) => {
  try {
    const userId = req.jwtDecoded._id
    const { entryId } = req.params

    const updatedEntry = await scheduleService.updateEntry(userId, entryId, req.body)

    res.status(StatusCodes.OK).json(updatedEntry)
  } catch (error) {
    next(error)
  }
}

const deleteEntry = async (req, res, next) => {
  try {
    const userId = req.jwtDecoded._id
    const { entryId } = req.params

    const deletedEntry = await scheduleService.deleteEntry(userId, entryId)

    res.status(StatusCodes.OK).json(deletedEntry)
  } catch (error) {
    next(error)
  }
}

export const scheduleController = {
  createNewEntry,
  getEntriesInRange,
  updateEntry,
  deleteEntry
}
