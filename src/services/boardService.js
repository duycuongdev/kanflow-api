import { slugify } from '~/utils/formatter'
import { boardModel } from '~/models/boardModel'
import { cloudinaryProvider } from '~/providers/CloudinaryProvider'
import ApiError from '~/utils/ApiError'
import { StatusCodes } from 'http-status-codes'
import { cloneDeep } from 'lodash'
import { columnModel } from '~/models/columnModel'
import { cardModel } from '~/models/cardModel'
import { invitationModel } from '~/models/invitationModel'
import { GET_DB } from '~/config/mongodb'
import { ObjectId } from 'mongodb'
import { DEFAULT_PAGE, DEFAULT_ITEMS_PER_PAGE } from '~/utils/constants'
import { authorizationService } from '~/services/authorizationService'
import { withTransaction } from '~/utils/withTransaction'
import { kickUserFromBoard } from '~/sockets/boardSocket'

const createNew = async (userId, reqBody) => {
  try {
    const { template = 'kanban', description = '', ...boardPayload } = reqBody
    const newBoard = {
      ...boardPayload,
      description,
      slug: slugify(reqBody.title)
    }

    const createBoard = await boardModel.createNew(userId, newBoard)
    const boardId = createBoard.insertedId

    if (template === 'kanban') {
      await withTransaction(async (session) => {
        // Tạo 3 cột mẫu chuẩn Kanban: To do, Doing, Done
        const colTodoRes = await columnModel.createNew({
          boardId: boardId.toString(),
          title: 'To do'
        }, { session })
        const colDoingRes = await columnModel.createNew({
          boardId: boardId.toString(),
          title: 'Doing'
        }, { session })
        const colDoneRes = await columnModel.createNew({
          boardId: boardId.toString(),
          title: 'Done'
        }, { session })

        const colTodoId = colTodoRes.insertedId
        const colDoingId = colDoingRes.insertedId
        const colDoneId = colDoneRes.insertedId

        // Tạo các thẻ mẫu thực tế kèm nhãn và checklist
        const card1Res = await cardModel.createNew({
          boardId: boardId.toString(),
          columnId: colTodoId.toString(),
          title: '👋 Chào mừng bạn! Kéo tôi sang cột Doing nhé',
          description: 'Kéo thả (Drag and drop) là tính năng cốt lõi của Trello. Bạn có thể kéo thẻ này qua lại giữa các cột để cập nhật tiến độ.',
          labels: [{ title: 'Bắt đầu', color: '#0052cc' }]
        }, { session })

        const card2Res = await cardModel.createNew({
          boardId: boardId.toString(),
          columnId: colTodoId.toString(),
          title: '🎯 Nhấp vào đây để xem Checklist & Hạn chót',
          description: 'Mỗi thẻ là một trung tâm công việc: bạn có thể chia nhỏ việc bằng Checklist, đặt hạn chót và thêm tệp đính kèm.',
          labels: [{ title: 'Mẹo hay', color: '#16a34a' }],
          checklists: [
            {
              title: 'Các bước làm quen',
              items: [
                { title: 'Khám phá giao diện Kanban', isDone: true },
                { title: 'Thử đổi hình nền bảng', isDone: false },
                { title: 'Tạo thẻ công việc đầu tiên của bạn', isDone: false }
              ]
            }
          ]
        }, { session })

        const card3Res = await cardModel.createNew({
          boardId: boardId.toString(),
          columnId: colDoneId.toString(),
          title: '🚀 Đã khởi tạo thành công không gian làm việc',
          description: 'Bảng Kanban đã sẵn sàng. Chúc bạn làm việc hiệu quả và năng suất!',
          labels: [{ title: 'Hoàn thành', color: '#10b981' }]
        }, { session })

        // Cập nhật cardOrderIds cho từng cột
        await columnModel.update(colTodoId.toString(), {
          cardOrderIds: [card1Res.insertedId.toString(), card2Res.insertedId.toString()]
        }, { session })

        await columnModel.update(colDoingId.toString(), {
          cardOrderIds: []
        }, { session })

        await columnModel.update(colDoneId.toString(), {
          cardOrderIds: [card3Res.insertedId.toString()]
        }, { session })

        // Cập nhật columnOrderIds cho board
        await boardModel.update(boardId.toString(), {
          columnOrderIds: [colTodoId.toString(), colDoingId.toString(), colDoneId.toString()]
        }, { session })
      })
    }

    const getNewBoard = await boardModel.findOneById(boardId)
    return getNewBoard
  } catch (error) { throw error }
}

const getDetails = async (userId, boardId) => {
  try {
    const board = await boardModel.getDetails(userId, boardId)
    if (!board) {
      throw new ApiError(StatusCodes.NOT_FOUND, 'Board not found!')
    }

    const resBoard = cloneDeep(board)
    // Lọc chỉ lấy các column chưa bị lưu trữ (_destroy !== true)
    resBoard.columns = (resBoard.columns || []).filter(col => col._destroy !== true)

    // Lọc columnOrderIds chỉ chứa id của các column active
    const activeColumnIds = new Set(resBoard.columns.map(c => c._id.toString()))
    resBoard.columnOrderIds = (resBoard.columnOrderIds || []).filter(id => activeColumnIds.has(id.toString()))

    resBoard.columns.forEach(column => {
      // Lọc các card chưa bị lưu trữ (_destroy !== true)
      column.cards = (resBoard.cards || [])
        .filter(card => card._destroy !== true)
        .filter(card => card.columnId.equals(column._id))

      // Lọc cardOrderIds của column
      const activeCardIds = new Set(column.cards.map(c => c._id.toString()))
      column.cardOrderIds = (column.cardOrderIds || []).filter(id => activeCardIds.has(id.toString()))
    })

    delete resBoard.cards

    // Đảm bảo slug luôn tồn tại kể cả với dữ liệu cũ
    if (!resBoard.slug && resBoard.title) {
      resBoard.slug = slugify(resBoard.title)
    }

    return resBoard
  } catch (error) { throw error }
}

const update = async (userId, boardId, reqBody, boardBackgroundFile) => {
  try {
    // Kiểm tra quyền: chỉ Owner hoặc Member của board mới được cập nhật (fix IDOR)
    const board = await authorizationService.requireBoardAccess(userId, boardId)

    const updateData = {
      ...reqBody,
      updatedAt: Date.now()
    }

    if (reqBody.title) {
      updateData.slug = slugify(reqBody.title)
    }

    // Nếu người dùng upload file ảnh nền từ thiết bị, tải lên Cloudinary
    if (boardBackgroundFile) {
      if (board?.background && String(board.background).startsWith('http') && board.background.includes('res.cloudinary.com')) {
        cloudinaryProvider.deleteFile(board.background).catch(() => {})
      }
      const uploadResult = await cloudinaryProvider.streamUpload(boardBackgroundFile.buffer, 'boardBackgrounds')
      updateData.background = uploadResult.secure_url
    }

    const updatedBoard = await boardModel.update(boardId, updateData)

    return updatedBoard
  } catch (error) { throw error }
}

const moveCardToDifferentColumn = async (userId, reqBody) => {
  try {
    // Kiểm tra quyền: user phải là Owner/Member của board chứa card đang di chuyển (fix IDOR)
    const { card } = await authorizationService.requireBoardAccessByCardId(userId, reqBody.currentCardId)

    // Đảm bảo 2 column gửi lên đều thuộc board của card (tránh thao tác lệch board làm hỏng dữ liệu)
    const prevColumn = await columnModel.findOneById(reqBody.prevColumnId)
    const nextColumn = await columnModel.findOneById(reqBody.nextColumnId)
    if (!prevColumn || !nextColumn ||
      prevColumn.boardId.toString() !== card.boardId.toString() ||
      nextColumn.boardId.toString() !== card.boardId.toString()) {
      throw new ApiError(StatusCodes.BAD_REQUEST, 'Invalid column information!')
    }

    // 3 thao tác ghi phải cùng thành công hoặc cùng thất bại (atomic), nếu không cardOrderIds sẽ lệch nhau
    return await withTransaction(async (session) => {
      await columnModel.update(reqBody.prevColumnId, {
        cardOrderIds: reqBody.prevCardOrderIds,
        updatedAt: Date.now()
      }, { session })

      await columnModel.update(reqBody.nextColumnId, {
        cardOrderIds: reqBody.nextCardOrderIds,
        updatedAt: Date.now()
      }, { session })

      await cardModel.update(reqBody.currentCardId, {
        columnId: reqBody.nextColumnId
      }, { session })

      return { updateResult: 'Successfully' }
    })
  } catch (error) { throw error }
}

const getBoards = async (userId, page, itemsPerPage, queryFilter) => {
  try {
    if (!page) page = DEFAULT_PAGE
    if (!itemsPerPage) itemsPerPage = DEFAULT_ITEMS_PER_PAGE

    const results = await boardModel.getBoards(userId, parseInt(page, 10), parseInt(itemsPerPage, 10), queryFilter)

    return results
  } catch (error) { throw error }
}

const removeMember = async (currentUserId, boardId, targetUserId) => {
  try {
    const board = await boardModel.findOneById(boardId)
    if (!board) throw new ApiError(StatusCodes.NOT_FOUND, 'Board not found!')

    // Chỉ owner của board mới có quyền xóa member, hoặc user tự rời khỏi board
    const isOwner = (board.ownerIds || []).some(id => id.toString() === currentUserId.toString())
    const isSelfLeaving = currentUserId.toString() === targetUserId.toString()

    if (!isOwner && !isSelfLeaving) {
      throw new ApiError(StatusCodes.FORBIDDEN, 'You do not have permission to remove members from this board!')
    }

    // Không thể xóa owner ra khỏi board
    const isTargetOwner = (board.ownerIds || []).some(id => id.toString() === targetUserId.toString())
    if (isTargetOwner) {
      throw new ApiError(StatusCodes.BAD_REQUEST, 'Cannot remove board owner!')
    }

    await boardModel.pullMemberIds(boardId, targetUserId)
    await cardModel.pullMemberFromAllCardsInBoard(boardId, targetUserId)

    // Kick user vừa bị xóa khỏi phòng socket của board + báo cho họ biết (real-time)
    kickUserFromBoard(targetUserId, boardId)

    return { removeResult: 'Member removed successfully!' }
  } catch (error) { throw error }
}

const getArchivedItems = async (userId, boardId) => {
  try {
    const board = await boardModel.findOneById(boardId)
    if (!board) {
      throw new ApiError(StatusCodes.NOT_FOUND, 'Board not found!')
    }

    const isOwner = (board.ownerIds || []).some(id => id.toString() === userId.toString())
    const isMember = (board.memberIds || []).some(id => id.toString() === userId.toString())
    if (!isOwner && !isMember) {
      throw new ApiError(StatusCodes.FORBIDDEN, 'You do not have permission to view archived items of this board!')
    }

    const archivedCards = await GET_DB().collection(cardModel.CARD_COLLECTION_NAME).aggregate([
      {
        $match: {
          boardId: new ObjectId(boardId),
          _destroy: true
        }
      },
      {
        $lookup: {
          from: columnModel.COLUMN_COLLECTION_NAME,
          localField: 'columnId',
          foreignField: '_id',
          as: 'column'
        }
      },
      {
        $addFields: {
          columnTitle: { $arrayElemAt: ['$column.title', 0] }
        }
      },
      {
        $project: {
          column: 0
        }
      }
    ]).toArray()

    const archivedColumns = await GET_DB().collection(columnModel.COLUMN_COLLECTION_NAME).find({
      boardId: new ObjectId(boardId),
      _destroy: true
    }).toArray()

    return {
      cards: archivedCards,
      columns: archivedColumns
    }
  } catch (error) { throw error }
}

const closeBoard = async (userId, boardId) => {
  try {
    const board = await boardModel.findOneById(boardId)
    if (!board) {
      throw new ApiError(StatusCodes.NOT_FOUND, 'Board not found!')
    }

    const isOwner = (board.ownerIds || []).some(id => id.toString() === userId.toString())
    if (!isOwner) {
      throw new ApiError(StatusCodes.FORBIDDEN, 'Only board owners can close this board!')
    }

    await boardModel.update(boardId, {
      _destroy: true,
      updatedAt: Date.now()
    })

    return { message: 'Board closed successfully!', boardId }
  } catch (error) { throw error }
}

const reopenBoard = async (userId, boardId) => {
  try {
    const board = await boardModel.findOneById(boardId)
    if (!board) {
      throw new ApiError(StatusCodes.NOT_FOUND, 'Board not found!')
    }

    const isOwner = (board.ownerIds || []).some(id => id.toString() === userId.toString())
    if (!isOwner) {
      throw new ApiError(StatusCodes.FORBIDDEN, 'Only board owners can reopen this board!')
    }

    await boardModel.update(boardId, {
      _destroy: false,
      updatedAt: Date.now()
    })

    return { message: 'Board reopened successfully!', boardId }
  } catch (error) { throw error }
}

const deleteBoard = async (userId, boardId) => {
  try {
    const board = await boardModel.findOneById(boardId)
    if (!board) {
      throw new ApiError(StatusCodes.NOT_FOUND, 'Board not found!')
    }

    const isOwner = (board.ownerIds || []).some(id => id.toString() === userId.toString())
    if (!isOwner) {
      throw new ApiError(StatusCodes.FORBIDDEN, 'Only board owners can permanently delete this board!')
    }

    // Cascade delete 4 collection phải là atomic: xóa dở sẽ để lại columns/cards/invitations mồ côi
    return await withTransaction(async (session) => {
      // 1. Delete board document
      await boardModel.deleteOneById(boardId, { session })

      // 2. Cascading delete columns
      await columnModel.deleteManyByBoardId(boardId, { session })

      // 3. Cascading delete cards
      await cardModel.deleteManyByBoardId(boardId, { session })

      // 4. Cascading delete invitations
      await invitationModel.deleteManyByBoardId(boardId, { session })

      return { deleteResult: 'Board and all associated data permanently deleted!' }
    })
  } catch (error) { throw error }
}

export const boardService = {
  createNew,
  getDetails,
  update,
  moveCardToDifferentColumn,
  getBoards,
  removeMember,
  getArchivedItems,
  closeBoard,
  reopenBoard,
  deleteBoard
}
