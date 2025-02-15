const path = require('path')
const _ = require('lodash')
const fs = require('fs-extra')
const symbols = require('log-symbols')
const debug = require('debug')('yun:index')
const pretry = require('promise.retry')
const sanitize = require('filenamify')
const dl = require('dl-vampire')
const ProgressBar = require('ascii-progress')
const getPlayurl = require('./api/playurl')
const { rp } = require('./singleton.js')

/**
 * page type
 */

const types = (exports.types = [
  {
    type: 'playlist',
    typeText: '列表',
  },
  {
    type: 'album',
    typeText: '专辑',
  },
])

/**
 * 获取html
 */

exports.getHtml = url => rp.get(url)

/**
 * mormalize url
 *
 * http://music.163.com/#/playlist?id=12583200
 * to
 * http://music.163.com/playlist?id=12583200
 */

exports.normalizeUrl = url => url.replace(/(https?:.*?\/)(#\/)/, '$1')

/**
 * 取得 content-length
 */

exports.getSize = async url => {
  const res = await rp.head(url, {
    resolveWithFullResponse: true,
  })
  let len = res.headers['content-length']
  if (!len) return

  len = parseInt(len, 10)
  debug('content-length %s for %s', len, url)
  return len
}

/**
 * 下载一首歌曲
 */

exports.downloadSong = async function(options = {}) {
  const { progress } = options
  if (progress) {
    return exports.downloadSongWithProgress(options)
  } else {
    return exports.downloadSongPlain(options)
  }
}

exports.downloadSongWithProgress = async function(options) {
  const { url, file, song, totalLength, retryTimeout, retryTimes, skipExists } = options

  let bar
  const initBar = () => {
    bar = new ProgressBar({
      schema: `:symbol ${song.index}/${totalLength} [:bar] :postText`,
      total: 100,
      current: 0,
      width: 10,
      filled: '=',
      blank: ' ',
    })
  }

  // 成功
  const success = () => {
    bar.update(1, { symbol: symbols.success, postText: `下载成功 ${file}` })
  }

  // 失败
  const fail = () => {
    bar.update(0, { symbol: symbols.error, postText: `下载失败 ${file}` })
    bar.terminate()
  }

  // 下载中
  const downloading = percent =>
    bar.update(percent, { symbol: symbols.info, postText: `  下载中 ${file}` })

  // 重试
  const retry = i => {
    bar.tick(0, { symbol: symbols.warning, postText: ` ${i + 1}次失败 ${file}` })
  }

  // init state
  initBar()
  downloading(0)

  try {
    await dl({
      url,
      file,
      skipExists,
      onprogress(p) {
        const { percent } = p
        if (percent === 1) {
          success()
        } else {
          downloading(percent)
        }
      },
      retry: {
        timeout: retryTimeout,
        times: retryTimes,
        onerror: function(e, i) {
          retry(i)
        },
      },
    })
  } catch (e) {
    fail()
    return
  }

  success()
}

exports.downloadSongPlain = async function(options) {
  const { url, file, song, totalLength, retryTimeout, retryTimes, skipExists } = options

  try {
    await dl({
      url,
      file,
      skipExists,
      retry: {
        timeout: retryTimeout,
        times: retryTimes,
        onerror: function(e, i) {
          console.log(`${symbols.warning} ${song.index}/${totalLength}  ${i + 1}次失败 ${file}`)
        },
      },
    })
  } catch (e) {
    console.log(`${symbols.error} ${song.index}/${totalLength} 下载失败 ${file}`)
    console.error(e.stack || e)
    return
  }

  console.log(`${symbols.success} ${song.index}/${totalLength} 下载完成 ${file}`)
}

/**
 * check page type
 *
 * @param { String } url
 * @return { Object } {type, typeText}
 */

exports.getType = url => {
  const item = _.find(types, item => url.indexOf(item.type) > -1)
  if (item) return item

  const msg = 'unsupported type'
  throw new Error(msg)
}

/**
 * get a adapter via `url`
 *
 * an adapter should have {
 *   getTitle($) => string
 *   getDetail($, url, quality) => [song, ...]
 * }
 */

exports.getAdapter = url => {
  const type = exports.getType(url)
  const typeKey = type.type
  const Adapter = require('./adapter/' + typeKey)
  return new Adapter()
}

/**
 * 获取title
 */

exports.getTitle = ($, url) => {
  const adapter = exports.getAdapter(url)
  return adapter.getTitle($)
}

/**
 * 获取歌曲
 */

exports.getSongs = async function($, url, quality) {
  const adapter = exports.getAdapter(url)

  // 基本信息
  let songs = await adapter.getDetail($, url, quality)

  // 获取下载链接
  const ids = songs.map(s => s.id)
  let json = await getPlayurl(ids, quality) // 0-29有链接, max 30? 没有链接都是下线的
  json = json.filter(s => s.url) // remove 版权保护没有链接的

  // 移除版权限制在json中没有数据的歌曲
  const removed = []
  for (let song of songs) {
    const id = song.id
    const ajaxData = _.find(json, ['id', id])

    if (!ajaxData) {
      // 版权受限
      removed.push(song)
    } else {
      // we are ok
      song.ajaxData = ajaxData
    }
  }

  const removedIds = _.map(removed, 'id')
  songs = _.reject(songs, s => _.includes(removedIds, s.id))

  // 根据详细信息获取歌曲
  return adapter.getSongs(songs)
}

/**
 * 获取歌曲文件表示
 */
exports.getFileName = options => {
  let format = options.format
  const song = options.song
  const typesItem = exports.getType(options.url)
  const name = options.name // 专辑 or playlist 名称
  // console.log(options);

  // 从 type 中取值, 先替换 `长的`
  ;['typeText', 'type'].forEach(t => {
    const val = sanitize(String(typesItem[t]))
    format = format.replace(new RegExp(':' + t, 'ig'), val)
  })

  // 从 `song` 中取值
  ;['songName', 'singer', 'rawIndex', 'index', 'ext'].forEach(t => {
    // t -> token
    // rawIndex 为 number, sanitize(number) error
    const val = sanitize(String(song[t]))
    format = format.replace(new RegExp(':' + t, 'ig'), val)
  })

  // name
  format = format.replace(new RegExp(':name', 'ig'), sanitize(name))

  return format
}
