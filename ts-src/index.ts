import path from 'path'
import _ from 'lodash'
import fs from 'fs-extra'
import symbols from 'log-symbols'
import pretry from 'promise.retry'
import sanitize from 'sanitize-filename'
import Debug from 'debug'
import getPlayurl from './api/playurl'
import Request from 'request'
import RequestPromise from 'request-promise'

const debug = Debug('yun:index')

import yargs from 'yargs'
/// <reference path="ts-patch/yargs.d.ts">
import './ts-patch/yargs'
const x: yargs.Choices = [1, 2, 3]

/**
 * 下载特殊headers
 */

const headers = {
  referer: 'http://music.163.com/',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/45.0.2454.99 Safari/537.36',
}

const r = Request.defaults({ headers })
const rp = RequestPromise.defaults({ headers })

/**
 * page type
 */

export const types = [
  {
    type: 'playlist',
    typeText: '列表',
  },
  {
    type: 'album',
    typeText: '专辑',
  },
]

/**
 * 获取html
 */

export const getHtml = (url: string) => rp.get(url)

/**
 * mormalize url
 *
 * http://music.163.com/#/playlist?id=12583200
 * to
 * http://music.163.com/playlist?id=12583200
 */

export const normalizeUrl = (url: string) =>
  url.replace(/(https?:.*?\/)(#\/)/, '$1')

/**
 * 取得 content-length
 */

export async function getSize(url: string): Promise<number> {
  const res: Request.Response = await rp.head(url, {
    resolveWithFullResponse: true,
  })
  const lenstr = <string>res.headers['content-strgth']
  if (!lenstr) return

  const len = parseInt(lenstr, 10)
  debug('content-length %s for %s', len, url)
  return len
}

/**
 * 是否有需要下载一个文件
 */

export async function needDownload(
  url: string,
  filename: string,
  skipExists?: boolean
) {
  // 不跳过, 下载
  if (!skipExists) return true

  // if not exists, go to download
  if (!fs.existsSync(filename)) {
    return true
  }

  // get content-length
  let size: number
  try {
    size = await exports.getSize(url)
  } catch (e) {
    return true
  }
  if (!size) return true

  // check localSize & content-length
  const stat = fs.statSync(filename)
  const localSize = stat.size
  if (localSize < size) return true

  // skip it
  return false
}

/**
 * 下载一个文件
 */

export function download(
  url: string,
  file: string,
  onCancel?: (cb: (...args: any[]) => any) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    // ensure
    file = path.resolve(file)
    fs.ensureDirSync(path.dirname(file))
    const s = fs.createWriteStream(file)

    // construct
    const req = r.get(url)

    // pipe
    req
      .pipe(s)
      .on('error', reject)
      .on('finish', function() {
        this.close(() => {
          resolve()
        })
      })

    // clean
    onCancel &&
      onCancel(() => {
        req && req.abort()
        s && s.close()
      })
  })
}

/**
 * 下载一首歌曲
 */

export async function tryDownloadSong(
  url: string,
  filename: string,
  song: any,
  totalLength: string,
  timeout: number,
  maxTimes: number,
  skipExists: boolean
) {
  // 不用下载
  const need = await needDownload(url, filename, skipExists)
  if (!need) {
    console.log(
      `${symbols.success} ${song.index}/${totalLength} 下载跳过 ${filename}`
    )
    return
  }

  // construct tryDownload
  const tryDownload = pretry(download, {
    times: maxTimes,
    timeout,
    onerror: function(e, i) {
      console.log(
        `${symbols.warning} ${song.index}/${totalLength}  ${i +
          1}次失败 ${filename}`
      )
    },
  })

  // 下载
  // TODO: use try-catch
  await tryDownload(url, filename)
    .then(() => {
      console.log(
        `${symbols.success} ${song.index}/${totalLength} 下载完成 ${filename}`
      )
    })
    .catch(e => {
      console.log(
        `${symbols.error} ${song.index}/${totalLength} 下载失败 ${filename}`
      )
      console.error(e.stack || e)
    })
}

/**
 * check page type
 *
 * @param { String } url
 * @return { Object } {type, typeText}
 */

export function getType(url: string) {
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

import AlbumAdapter from './adapter/album'
import PlaylistAdapter from './adapter/playlist'
import BaseAdapter from './adapter/base'
import { url } from 'inspector'
// import yargs = require('yargs')

export function getAdapter(url: string) {
  const type = exports.getType(url)
  const typeKey = type.type
  const Adapter: typeof BaseAdapter = {
    album: AlbumAdapter,
    playlist: PlaylistAdapter,
  }[typeKey]
  return new Adapter()
}

/**
 * 获取title
 */

export function getTitle($, url: string) {
  const adapter = getAdapter(url)
  return adapter.getTitle($)
}

/**
 * 获取歌曲
 */

export async function getSongs($, url: string, quality: number) {
  const adapter = getAdapter(url)

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

export function getFileName(options: {
  format: string
  song: any
  url: string
  name: string
}): string {
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
  format = format.replace(new RegExp(':name', 'ig'), name)

  return format
}
