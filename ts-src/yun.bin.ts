#!/usr/bin/env node

import path from 'path'
import cheerio from 'cheerio'
import pmap from 'promise.map'
import _ from 'lodash'
import yargs from 'yargs'
import './ts-patch/yargs'
import humanizeDuration from 'humanize-duration'
import Debug from 'debug'
import * as lib from './index'
import 'log-reject-error'
import pkg from '../package.json'
import rc from 'rc'

const { version } = pkg
const debug = Debug('yun:cli')

// get config
const config = rc('yun', {
  concurrency: 5,
  format: ':name/:singer - :songName.:ext',
  quality: 320,
  timeout: 3, // 3 mins
  'max-times': 3, // 3 times
  skip: true,
})

let argv = yargs.command(
  '$0 <url>',
  '网易云音乐 歌单/专辑 下载器',
  // builder
  yargs => {
    return yargs
      .usage('Usage: $0 <url> [options]')
      .positional('url', { describe: '歌单/专辑的链接', type: 'string' })
      .alias({
        h: 'help',
        v: 'version',
        c: 'concurrency',
        f: 'format',
        q: 'quality',
        t: 'timeout',
        s: 'skip',
      })
      .option({
        concurrency: {
          desc: '同时下载数量',
          type: 'number',
          default: 5,
        },

        format: {
          desc: '文件格式',
          type: 'string',
          default: ':name/:singer - :songName.:ext',
        },

        quality: {
          desc: '音质',
          type: 'number',
          default: 320,
          choices: [128, 192, 320],
        },

        timeout: {
          desc: '下载超时(分)',
          type: 'number',
          default: 3,
        },

        maxTimes: {
          desc: '下载重试次数',
          type: 'number',
          default: 3,
        },

        skip: {
          desc: '对于已存在文件且大小合适则跳过',
          type: 'boolean',
          default: true,
        },
      })
      .config(config)
      .example('$0 -c 10 <url>', '10首同时下载')
      .example(
        'yun -f ":singer - :songName.:ext" <url>',
        '下载格式为 "歌手 - 歌名"'
      )
      .epilog(
        '帮助 & 文档: https://github.com/magicdawn/yun-playlist-downloader'
      )
  }
).argv

// url
let {
  url,
  concurrency,
  format,
  quality,
  timeout,
  maxTimes,
  skip: skipExists,
} = argv

quality *= 1000
timeout *= 60 * 1000 // minute -> ms

// 打印
console.log(`
当前参数
concurrency: ${argv.concurrency}
timeout:     ${argv.timeout}
max-times:   ${argv.maxTimes}
quality:     ${argv.quality}
format:      ${argv.format}
skip:        ${argv.skip}
`)

async function main() {
  url = lib.normalizeUrl(url)
  const html = await lib.getHtml(url)
  const $ = cheerio.load(html, {
    decodeEntities: false,
  })

  // 基本信息
  const name = lib.getTitle($, url)
  const songs = await lib.getSongs($, url, quality)
  debug('songs : %j', songs)
  const start = Date.now()
  console.log(`正在下载『${name}』,请稍候...`)

  // FIXME
  // process.exit()

  // 开始下载
  await pmap(
    songs,
    song => {
      // 根据格式获取所需文件名
      const filename = lib.getFileName({
        format: format,
        song: song,
        url: url,
        name: name,
      })

      // 下载
      return lib.tryDownloadSong(
        song.url,
        filename,
        song,
        songs.length,
        timeout,
        maxTimes,
        skipExists
      )
    },
    concurrency
  )

  const dur = humanizeDuration(Date.now() - start, {
    language: 'zh_CN',
  })
  console.log('下载完成, 耗时%s', dur)
}

main()
