/** @type {import('./_venera_.js')} */
class VomicMHComicSource extends ComicSource {
  // ============ 基本信息 ============
  name = 'vomic漫+';
  key = 'vomicmh';
  version = '1.4.0';
  minAppVersion = '1.6.0';
  url = '';

  static SITE = 'https://vomicmh.com';
  static API = 'https://api.vomicmh.com';
  static HOME_CATE = '4'; // 首页默认展示的分类(冒险)

  // ============ 请求头 ============
  get baseHeaders() {
    return {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Origin: VomicMHComicSource.SITE,
      Referer: `${VomicMHComicSource.SITE}/`,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
    };
  }

  // api 域用 Bearer
  authHeaders() {
    let token = this.loadData('token');
    let h = Object.assign({}, this.baseHeaders);
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }

  get isLogged() {
    let token = this.loadData('token');
    if (!token) return false;
    let expire = this.loadData('tokenExpire');
    if (expire && Date.now() > Number(expire)) return false;
    return true;
  }

  // 站点域(vomicmh.com)用 Cookie 鉴权: _token=<JWT>
  _applyCookie(token) {
    try {
      Network.setCookies(VomicMHComicSource.SITE, [
        new Cookie({
          name: '_token',
          value: token,
          domain: 'vomicmh.com',
          path: '/',
        }),
      ]);
    } catch (e) {
      // 某些版本 Cookie 构造为位置参数, 兜底
      try {
        Network.setCookies(VomicMHComicSource.SITE, [
          Cookie('_token', token, 'vomicmh.com'),
        ]);
      } catch (e2) {}
    }
  }

  _ensureLogged() {
    if (!this.isLogged) {
      throw '该源需要登录后才能使用（账号为邮箱），请在设置中登录';
    }
    // App 重启后内存 Cookie 可能丢失, 每次确保站点域 Cookie 存在
    let token = this.loadData('token');
    if (token) this._applyCookie(token);
  }

  _checkStatus(res) {
    if (res.status === 401 || res.status === 403)
      throw '登录状态失效，请重新登录';
    if (res.status !== 200) throw `请求失败: HTTP ${res.status}`;
  }

  // HTML 实体解码 (关键: &amp; 不解码会破坏图片签名参数)
  _decodeEntities(s) {
    return (s || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x2F;/g, '/')
      .replace(/&#39;/g, "'");
  }

  get imageQuality() {
    let v = null;
    try {
      v = this.loadSetting ? this.loadSetting('imageQuality') : null;
    } catch (e) {}
    if (v == null) v = this.loadData('imageQuality');
    return v === 'origin' ? 'origin' : 'default';
  }

  _applyQuality(url) {
    if (!url) return url;
    console.log('imageQuality = ' + this.imageQuality);
    if (this.imageQuality !== 'origin') return url;
    const newUrl = url
      .replace(/thumbnail\/\d+x/, 'thumbnail/1000x')
      .replace(/quality\/\d+/, 'quality/100');
    console.log('quality url: ' + newUrl);
    return newUrl;
  }

  init() {}

  // ============ 账号 / 登录鉴权 ============
  // POST /pics/login, body {email, password}
  // -> { code:200, data:{id,name,...}, token:"<JWT>", ttl:8640000 }
  account = {
    login: async (account, pwd) => {
      let res = await Network.post(
        `${VomicMHComicSource.API}/pics/login`,
        Object.assign({ 'Content-Type': 'application/json' }, this.baseHeaders),
        JSON.stringify({ email: account, password: pwd }),
      );
      if (res.status !== 200) throw `登录失败: HTTP ${res.status}`;
      let data = JSON.parse(res.body);
      if (data.code !== 200) {
        throw `登录失败: ${data.message ?? data.msg ?? 'code ' + data.code}`;
      }
      let token = data.token;
      if (!token) throw '登录失败: 未获取到 token';

      this.saveData('token', token);
      if (data.ttl) this.saveData('tokenExpire', Date.now() + data.ttl * 1000);
      if (data.data) {
        this.saveData('userId', `${data.data.id}`);
        this.saveData('userName', data.data.name ?? '');
      }
      // 站点域 Cookie 鉴权
      this._applyCookie(token);
      return 'ok';
    },
    logout: () => {
      this.deleteData('token');
      this.deleteData('tokenExpire');
      this.deleteData('userId');
      this.deleteData('userName');
      try {
        Network.deleteCookies(VomicMHComicSource.SITE);
      } catch (e) {}
    },
    registerWebsite: null,
  };

  // ============ HTML 解析辅助 ============
  _metaContent(doc, key) {
    let el =
      doc.querySelector(`meta[property='${key}']`) ||
      doc.querySelector(`meta[name='${key}']`);
    return el ? el.attributes['content'] || '' : '';
  }

  // 列表页解析 (/so/key, /so/cate)
  _parseListPage(body) {
    let doc = new HtmlDocument(body);
    try {
      let anchors = doc.querySelectorAll(
        "div.flex-wrap.justify-between a[href^='/detail/']",
      );
      if (anchors.length === 0) {
        anchors = doc.querySelectorAll("a[href^='/detail/']");
      }
      let comics = [];
      let seen = {};
      for (let a of anchors) {
        let href = a.attributes['href'] || '';
        let id = href.replace('/detail/', '').trim();
        if (!id || seen[id]) continue;
        seen[id] = true;
        let titleEl = a.querySelector('.title');
        let imgEl = a.querySelector('img');
        comics.push(
          new Comic({
            id: id,
            title: titleEl ? titleEl.text.trim() : '',
            cover: imgEl
              ? this._decodeEntities(imgEl.attributes['src'] || '')
              : '',
          }),
        );
      }
      // 分页器真实页数
      let maxPage = 1;
      let pageItems = doc.querySelectorAll(
        'ul.ant-pagination li.ant-pagination-item',
      );
      for (let li of pageItems) {
        let n = parseInt(li.attributes['title'] || li.text.trim());
        if (!isNaN(n) && n > maxPage) maxPage = n;
      }
      return { comics, maxPage };
    } finally {
      doc.dispose();
    }
  }

  // ============ 章节排序 ============
  get chapterOrder() {
    let v = this.loadData('chapterOrder');
    return v === 'desc' ? 'desc' : 'asc';
  }

  // 解析章节名 -> { group, num }
  // group 用数字做组优先级: 话=0, 卷=1, 其他=2
  _parseChapterName(name) {
    let t = (name || '').trim();
    let m = t.match(/(\d+(?:\.\d+)?)\s*话/);
    if (m) return { group: 0, num: parseFloat(m[1]) };
    m = t.match(/(\d+(?:\.\d+)?)\s*卷/);
    if (m) return { group: 1, num: parseFloat(m[1]) };
    return { group: 2, num: null };
  }

  // [{id,name}] -> 单层 Map<id, name>
  // 排序: 先按组别(话->卷->其他), 组内再按序号(正序/倒序)
  _buildChapterGroups(rawChapters) {
    let desc = this.chapterOrder === 'desc';

    let items = rawChapters.map((ch) => {
      let info = this._parseChapterName(ch.name);
      return {
        id: `${ch.id}`,
        name: ch.name,
        group: info.group,
        num: info.num,
      };
    });

    items.sort((a, b) => {
      if (a.group !== b.group) return a.group - b.group;
      if (a.num == null && b.num == null) return 0;
      if (a.num == null) return 1;
      if (b.num == null) return -1;
      return desc ? b.num - a.num : a.num - b.num;
    });

    let map = new Map();
    for (let it of items) map.set(it.id, it.name);
    return map;
  }

  // ============ 探索页 ============
  explore = [
    {
      title: 'vomic漫+',
      type: 'multiPageComicList',
      load: async (page) => {
        this._ensureLogged();
        let res = await Network.get(
          `${VomicMHComicSource.SITE}/so/cate/${VomicMHComicSource.HOME_CATE}/${page}`,
          this.baseHeaders,
        );
        this._checkStatus(res);
        return this._parseListPage(res.body);
      },
    },
  ];

  // ============ 分类 ============
  static CATEGORIES = [
    ['冒险', '4'],
    ['搞笑', '5'],
    ['动作', '6'],
    ['科幻', '7'],
    ['爱情', '8'],
    ['侦探', '9'],
    ['竞技', '10'],
    ['魔法', '11'],
    ['校园', '12'],
    ['百合', '13'],
    ['耽美', '14'],
    ['历史', '15'],
    ['战争', '16'],
    ['宅系', '17'],
    ['治愈', '18'],
    ['武侠', '20'],
    ['职场', '21'],
    ['神鬼', '22'],
    ['奇幻', '23'],
    ['生活', '24'],
    ['其他', '25'],
    ['热血', '26'],
    ['古风', '27'],
    ['悬疑', '28'],
    ['都市', '29'],
    ['架空', '30'],
    ['青春', '31'],
    ['剧情', '32'],
    ['犯罪', '34'],
    ['致郁', '35'],
    ['纯爱', '36'],
    ['恋爱', '37'],
    ['体育', '38'],
    ['末世', '39'],
    ['少女', '40'],
    ['重生', '41'],
    ['美食', '43'],
  ];

  category = {
    title: 'vomic漫+',
    parts: [
      {
        name: '题材',
        type: 'fixed',
        categories: VomicMHComicSource.CATEGORIES.map((c) => c[0]),
        itemType: 'category',
        categoryParams: VomicMHComicSource.CATEGORIES.map((c) => c[1]),
      },
    ],
    enableRankingPage: false,
  };

  categoryComics = {
    load: async (category, param, options, page) => {
      this._ensureLogged();
      let res = await Network.get(
        `${VomicMHComicSource.SITE}/so/cate/${param}/${page}`,
        this.baseHeaders,
      );
      this._checkStatus(res);
      return this._parseListPage(res.body);
    },
    optionList: [],
  };

  // 从搜索输入中提取 car_id (支持 detail/chapter 链接)
  _extractCarId(input) {
    let s = (input || '').trim();
    let m = s.match(/\/detail\/(\d+)/);
    if (m) return m[1];
    m = s.match(/\/chapter\/(\d+)/);
    if (m) return m[1];
    return null;
  }

  // ============ 搜索 ============
  search = {
    load: async (keyword, options, page) => {
      this._ensureLogged();

      // 直达: 输入为 detail/chapter 链接时, 直接返回该作品
      let directId = this._extractCarId(keyword);
      if (directId) {
        return {
          comics: [
            new Comic({
              id: directId,
              title: `作品 #${directId}`,
              cover: '',
            }),
          ],
          maxPage: 1,
        };
      }

      // 常规关键词搜索
      let res = await Network.get(
        `${VomicMHComicSource.SITE}/so/key/${encodeURIComponent(keyword)}/${page}`,
        this.baseHeaders,
      );
      this._checkStatus(res);
      return this._parseListPage(res.body);
    },
    optionList: [],
  };

  // ============ 漫画详情 + 读图 ============
  comic = {
    // id 即 car_id, 解析 /detail/{car_id} 的 HTML
    loadInfo: async (id) => {
      this._ensureLogged();
      let res = await Network.get(
        `${VomicMHComicSource.SITE}/detail/${id}`,
        this.baseHeaders,
      );
      this._checkStatus(res);

      let doc = new HtmlDocument(res.body);
      try {
        let detail = doc.querySelector('.detail');

        // 标题
        let title = '';
        if (detail) {
          let t = detail.querySelector('.text-nowrap');
          title = t ? t.text.trim() : '';
        }
        if (!title) {
          title = (this._metaContent(doc, 'og:title') || '')
            .replace(/\s*-\s*vomic漫.*$/, '')
            .trim();
        }

        // 封面 (解码实体)
        let coverEl = doc.querySelector("img[alt='cover']");
        let cover = coverEl
          ? this._decodeEntities(coverEl.attributes['src'] || '')
          : '';
        if (!cover)
          cover = this._decodeEntities(
            this._metaContent(doc, 'og:image') || '',
          );

        // 作者 / 简介 / 上传人 / 分类标签
        let author = '';
        let description = '';
        let uploader = '';
        let themeTags = [];

        if (detail) {
          let upEl = detail.querySelector('ul li .text-xs');
          if (upEl) uploader = upEl.text.trim();

          let blocks = detail.querySelectorAll(
            'div.line-clamp-1, div.line-clamp-4',
          );
          for (let b of blocks) {
            let label = b.querySelector('.text-sm');
            let value = b.querySelector('.text-xs');
            if (!label) continue;
            let labelText = label.text.trim();
            if (labelText.includes('作者')) {
              author = value ? value.text.trim() : '';
            } else if (labelText.includes('简介')) {
              description = value ? value.text.trim() : '';
            }
          }

          let cateEls = detail.querySelectorAll("a[href^='/so/cate/']");
          themeTags = cateEls.map((a) => a.text.trim()).filter(Boolean);
        }

        // 章节: 收集后分组排序 (话/卷/其他)
        let rawChapters = [];
        let chapterEls = doc.querySelectorAll("a[href^='/chapter/']");
        for (let a of chapterEls) {
          let href = a.attributes['href'] || '';
          let m = href.match(/\/chapter\/\d+\/(\d+)/);
          if (!m) continue;
          rawChapters.push({ id: m[1], name: a.text.trim() });
        }
        let chapters = this._buildChapterGroups(rawChapters);

        let tags = {};
        if (author) tags['作者'] = author.split(/\s+/).filter(Boolean);
        if (themeTags.length) tags['分类'] = themeTags;
        if (uploader) tags['上传人'] = [uploader];

        return new ComicDetails({
          title: title,
          cover: cover,
          description: description,
          tags: tags,
          chapters: chapters,
        });
      } finally {
        doc.dispose();
      }
    },

    // comicId = car_id, epId = chapter_id
    // 读图页 /chapter/{car_id}/{chapter_id}, 站点域 Cookie(_token) 鉴权
    // #myscroll > img.myimage 含整章全部图片
    loadEp: async (comicId, epId) => {
      this._ensureLogged();
      let res = await Network.get(
        `${VomicMHComicSource.SITE}/chapter/${comicId}/${epId}`,
        this.baseHeaders, // Cookie 由 cookie jar 自动附加
      );
      if (res.status === 401 || res.status === 403) {
        throw '需要登录后才能阅读，请在设置中登录账号';
      }
      if (res.status !== 200) throw `加载章节失败: HTTP ${res.status}`;

      let doc = new HtmlDocument(res.body);
      try {
        let imgEls = doc.querySelectorAll('#myscroll img.myimage');
        if (imgEls.length === 0) imgEls = doc.querySelectorAll('img.myimage');

        let images = [];
        for (let img of imgEls) {
          // 关键: 解码 &amp;, 否则签名参数被破坏导致 403
          let src = this._decodeEntities(img.attributes['src'] || '');
          if (src) images.push(this._applyQuality(src));
        }
        if (images.length === 0) {
          throw '未获取到图片，可能需要重新登录';
        }
        return { images };
      } finally {
        doc.dispose();
      }
    },

    // cdm.vomicer.com 防盗链: 需 Referer + Origin + UA
    onImageLoad: (url, comicId, epId) => {
      return {
        headers: {
          Referer: `${VomicMHComicSource.SITE}/`,
          Origin: VomicMHComicSource.SITE,
          'User-Agent': this.baseHeaders['User-Agent'],
        },
      };
    },

    // 可选: 上报阅读历史
    // POST /pics/c/writeViewHis, body {car_id, info:{id, name, page}}
    onReadEnd: async (comicId, epId) => {
      if (!this.isLogged) return;
      try {
        await Network.post(
          `${VomicMHComicSource.API}/pics/c/writeViewHis`,
          Object.assign(
            { 'Content-Type': 'application/json' },
            this.authHeaders(),
          ),
          JSON.stringify({
            car_id: `${comicId}`,
            info: { id: `${epId}`, name: '', page: 1 },
          }),
        );
      } catch (e) {}
    },

    enableTagsSuggestions: false,
  };

  // ============ 源设置 ============
  settings = {
    chapterOrder: {
      title: '章节排序',
      type: 'select',
      options: [
        { value: 'asc', text: '正序（1→N）' },
        { value: 'desc', text: '倒序（N→1）' },
      ],
      default: 'asc',
    },
    imageQuality: {
      title: '画质',
      type: 'select',
      options: [
        { value: 'default', text: '默认（800x / 75）' },
        { value: 'origin', text: '原画（1000x / 100）' },
      ],
      default: 'origin',
    },
  };
}
