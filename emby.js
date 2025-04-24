"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const axios_1 = require("axios");

const pageSize = 50;
const LYRICS_API_BASE_URL = 'https://lrc.xms.mx';
const ALL_PLAYLISTS_TAG = { id: 'emby__all_playlists', title: 'Emby 播放列表' };
const ALL_SONGS_TAG = { id: 'emby__all_songs', title: '所有歌曲' };
const NCM_IMPORT_CONCURRENCY = 5;
const NCM_MATCH_RESULT_COUNT = 5;
const DURATION_TOLERANCE_SECONDS = 5;

let embyAccessToken = null;
let embyUserId = null;
let embyHost = null;
let embyClientInfo = {
    Client: "MusicFree",
    Device: "MusicFreePlayer",
    DeviceId: "MusicFreeDevice-" + Math.random().toString(36).substring(2, 15),
    Version: "1.0.0"
};

function getEmbyAuthHeader() {
    if (!embyAccessToken) {
        return null;
    }
    const authValue = `MediaBrowser Client="${embyClientInfo.Client}", Device="${embyClientInfo.Device}", DeviceId="${embyClientInfo.DeviceId}", Version="${embyClientInfo.Version}", Token="${embyAccessToken}"`;
    return {
        'X-Emby-Authorization': authValue,
    };
}

async function loginEmby(url, username, password) {
    console.log("Emby Plugin: Attempting login...");
    const loginUrl = `${url}/Users/AuthenticateByName`;
    try {
        const response = await axios_1.default.post(loginUrl, {
            Username: username,
            Pw: password
        }, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.data && response.data.AccessToken && response.data.User && response.data.User.Id) {
            embyAccessToken = response.data.AccessToken;
            embyUserId = response.data.User.Id;
            embyHost = url;
            console.log("Emby Plugin: Login successful. UserID:", embyUserId);
            return true;
        } else {
            console.error("Emby Plugin: Login failed - Invalid response structure", response.data);
            throw new Error("Emby 登录失败：服务器响应无效。");
        }
    } catch (error) {
        console.error("Emby Plugin: Login request failed.", error);
        embyAccessToken = null;
        embyUserId = null;
        embyHost = null;
        if (error.response) {
             throw new Error(`Emby 登录失败 (${error.response.status}): ${error.response.data?.error_message || error.message}`);
        } else {
             throw new Error(`Emby 登录失败: ${error.message}`);
        }
    }
}

async function ensureEmbyLogin() {
    if (embyAccessToken && embyUserId && embyHost) {
        return true;
    }
    console.log("Emby Plugin: Not logged in or token expired. Attempting login...");
    const userVariables = env?.getUserVariables() ?? {};
    const { url, username, password } = userVariables;
    if (!url || !username || !password) {
        throw new Error("请先在插件设置中填写 Emby 服务器地址、用户名和密码。");
    }
    let hostUrl = url;
    if (!hostUrl.startsWith("http://") && !hostUrl.startsWith("https://")) {
        hostUrl = `http://${hostUrl}`;
    }
    hostUrl = hostUrl.replace(/\/+$/, "");

    return await loginEmby(hostUrl, username, password);
}

async function embyApiGet(urlPath, params = {}) {
    await ensureEmbyLogin();
    const fullUrl = `${embyHost}${urlPath}`;
    const headers = getEmbyAuthHeader();
    if (!headers) {
        throw new Error("Emby 未认证，无法发送请求。");
    }

    try {
        const response = await axios_1.default.get(fullUrl, {
             params: params,
             headers: headers,
             timeout: 20000
        });
        return response.data;
    } catch (error) {
        console.error(`Emby Plugin: API GET request failed for ${fullUrl}. Error:`, error);
        if (error.response?.status === 401) {
             console.log("Emby Plugin: Received 401 Unauthorized, attempting relogin...");
             embyAccessToken = null;
             embyUserId = null;
             await ensureEmbyLogin();
             const retryHeaders = getEmbyAuthHeader();
             if (retryHeaders) {
                 try {
                     const retryResponse = await axios_1.default.get(fullUrl, { params: params, headers: retryHeaders, timeout: 20000 });
                     return retryResponse.data;
                 } catch (retryError) {
                     console.error(`Emby Plugin: API GET request failed even after relogin for ${fullUrl}. Error:`, retryError);
                     throw new Error(`Emby API 请求失败 (重试后): ${retryError.message}`);
                 }
             } else {
                 throw new Error("Emby API 请求失败：重新登录后仍无法认证。");
             }
        }
        throw new Error(`Emby API 请求失败: ${error.message}`);
    }
}

function getEmbyArtworkUrl(itemId, imageTag, type = 'Primary', maxWidth = 600, maxHeight = 600) {
    if (!itemId || !imageTag) {
        return null;
    }
    // Ensure embyHost is set before calling this
    if (!embyHost) {
        console.warn("Emby Plugin: Cannot get artwork URL, host not set.");
        return null;
    }
    return `${embyHost}/Items/${itemId}/Images/${type}?tag=${imageTag}&maxWidth=${maxWidth}&maxHeight=${maxHeight}&quality=90`;
}

function formatEmbyMusicItem(embyItem) {
    const artists = embyItem.Artists || [];
    const primaryImageTag = embyItem.ImageTags?.Primary || embyItem.AlbumPrimaryImageTag;

    return {
        id: String(embyItem.Id),
        title: embyItem.Name || "未知歌曲",
        artist: artists.join(', ') || "未知艺术家",
        album: embyItem.Album || "未知专辑",
        artwork: getEmbyArtworkUrl(embyItem.Id, primaryImageTag),
        duration: embyItem.RunTimeTicks ? Math.round(embyItem.RunTimeTicks / 10000000) : undefined,
        _source: 'emby'
    };
}

function formatEmbyAlbumItem(embyItem) {
    const albumArtists = embyItem.AlbumArtists || (embyItem.ArtistItems ? embyItem.ArtistItems.map(a => a.Name) : []);
    const primaryImageTag = embyItem.ImageTags?.Primary;

    return {
        id: String(embyItem.Id),
        title: embyItem.Name || "未知专辑",
        artist: albumArtists.map(a => a.Name || a).join(', ') || "未知艺术家",
        artwork: getEmbyArtworkUrl(embyItem.Id, primaryImageTag),
        description: `年份: ${embyItem.ProductionYear || '?'}`,
        year: embyItem.ProductionYear
    };
}

function formatEmbyArtistItem(embyItem) {
    const primaryImageTag = embyItem.ImageTags?.Primary;
    return {
        id: String(embyItem.Id),
        name: embyItem.Name || "未知艺术家",
        avatar: getEmbyArtworkUrl(embyItem.Id, primaryImageTag),
    };
}

function formatEmbyPlaylistItem(embyItem) {
    const primaryImageTag = embyItem.ImageTags?.Primary;
    return {
        id: String(embyItem.Id),
        title: embyItem.Name || "未知播放列表",
        artist: "Emby",
        artwork: getEmbyArtworkUrl(embyItem.Id, primaryImageTag, 'Primary', 200, 200),
        description: `歌曲: ${embyItem.ChildCount || '?'}`,
    };
}

function formatNcmMusicItem(ncmSong) {
    var _a, _b;
    const album = ncmSong.al || ncmSong.album;
    const artists = ncmSong.ar || ncmSong.artists;
    return {
        id: `ncm-tmp-${String(ncmSong.id)}`,
        title: ncmSong.name || "未知歌曲",
        artist: (Array.isArray(artists) && artists.length > 0) ? artists.map(a => a.name).join('/') : "未知艺术家",
        album: album?.name || "未知专辑",
        artwork: album?.picUrl,
        duration: ncmSong.dt ? Math.round(ncmSong.dt / 1000) : undefined,
        _source: 'ncm-import',
        _ncmId: String(ncmSong.id)
    };
}

async function searchMusic(query, page, count = pageSize) {
    const startIndex = (page - 1) * count;
    const params = {
        UserId: embyUserId,
        SearchTerm: query,
        IncludeItemTypes: 'Audio',
        Recursive: true,
        Fields: 'SortName,MediaSources,ProductionYear,PrimaryImageAspectRatio,BasicSyncInfo',
        EnableImageTypes: 'Primary',
        ImageTypeLimit: 1,
        StartIndex: startIndex,
        Limit: count,
        SortBy: 'SortName',
        SortOrder: 'Ascending'
    };
    const data = await embyApiGet('/Users/' + embyUserId + '/Items', params);
    const songs = data?.Items ?? [];
    return {
        isEnd: (startIndex + songs.length) >= (data?.TotalRecordCount ?? 0),
        data: songs.map(formatEmbyMusicItem)
    };
}

async function searchAlbum(query, page) {
    const startIndex = (page - 1) * pageSize;
    const params = {
        UserId: embyUserId,
        SearchTerm: query,
        IncludeItemTypes: 'MusicAlbum',
        Recursive: true,
        Fields: 'SortName,ProductionYear,BasicSyncInfo,ChildCount',
        EnableImageTypes: 'Primary',
        ImageTypeLimit: 1,
        StartIndex: startIndex,
        Limit: pageSize,
        SortBy: 'SortName',
        SortOrder: 'Ascending'
    };
    const data = await embyApiGet('/Users/' + embyUserId + '/Items', params);
    const albums = data?.Items ?? [];
    return {
        isEnd: (startIndex + albums.length) >= (data?.TotalRecordCount ?? 0),
        data: albums.map(formatEmbyAlbumItem)
    };
}

async function searchArtist(query, page) {
    const startIndex = (page - 1) * pageSize;
    const params = {
        UserId: embyUserId,
        SearchTerm: query,
        Recursive: true,
        Fields: 'SortName,BasicSyncInfo,PrimaryImageAspectRatio',
        EnableImageTypes: 'Primary',
        ImageTypeLimit: 1,
        StartIndex: startIndex,
        Limit: pageSize,
        SortBy: 'SortName',
        SortOrder: 'Ascending'
    };
    let data;
    try {
        data = await embyApiGet('/Artists', params);
    } catch (e) {
        console.warn("Emby Plugin: Failed to search /Artists, trying /Artists/AlbumArtists...");
        data = await embyApiGet('/Artists/AlbumArtists', params);
    }

    const artists = data?.Items ?? [];
    return {
        isEnd: (startIndex + artists.length) >= (data?.TotalRecordCount ?? 0),
        data: artists.map(formatEmbyArtistItem)
    };
}

async function searchSheet(query, page) {
    const startIndex = (page - 1) * pageSize;
    const params = {
        UserId: embyUserId,
        SearchTerm: query,
        IncludeItemTypes: 'Playlist',
        Recursive: true,
        mediaTypes: 'Audio',
        Fields: 'SortName,CanDelete,PrimaryImageAspectRatio,BasicSyncInfo,ChildCount',
        EnableImageTypes: 'Primary',
        ImageTypeLimit: 1,
        StartIndex: startIndex,
        Limit: pageSize,
        SortBy: 'SortName',
        SortOrder: 'Ascending'
    };
    const data = await embyApiGet('/Users/' + embyUserId + '/Items', params);
    const playlists = data?.Items ?? [];
    return {
        isEnd: (startIndex + playlists.length) >= (data?.TotalRecordCount ?? 0),
        data: playlists.map(formatEmbyPlaylistItem)
    };
}

async function getAlbumInfoApi(albumItem, page) {
     if (page > 1) {
         return { isEnd: true, musicList: [] };
     }
    const params = {
        UserId: embyUserId,
        ParentId: albumItem.id,
        IncludeItemTypes: 'Audio',
        Recursive: true,
        Fields: 'SortName,MediaSources,ProductionYear,PrimaryImageAspectRatio,BasicSyncInfo',
        EnableImageTypes: 'Primary',
        ImageTypeLimit: 1,
        SortBy: 'ParentIndexNumber,IndexNumber,SortName',
        SortOrder: 'Ascending'
    };
    const data = await embyApiGet('/Users/' + embyUserId + '/Items', params);
    const songs = data?.Items ?? [];
    const supplementaryAlbumData = formatEmbyAlbumItem(albumItem);

    return {
        isEnd: true,
        musicList: songs.map(formatEmbyMusicItem),
        albumItem: supplementaryAlbumData
    };
}

async function getMusicSheetInfoApi(sheetItem, page) {
    if (sheetItem.id === ALL_SONGS_TAG.id) {
        return await getAllSongsApi(page);
    }

    const startIndex = (page - 1) * pageSize;
    const params = {
        UserId: embyUserId,
        ParentId: sheetItem.id,
        IncludeItemTypes: 'Audio',
        Recursive: true,
        Fields: 'SortName,MediaSources,ProductionYear,PrimaryImageAspectRatio,BasicSyncInfo',
        EnableImageTypes: 'Primary',
        ImageTypeLimit: 1,
        StartIndex: startIndex,
        Limit: pageSize,
        SortBy: 'SortName',
        SortOrder: 'Ascending'
    };
    const data = await embyApiGet('/Users/' + embyUserId + '/Items', params);
    const songs = data?.Items ?? [];
    const supplementarySheetData = formatEmbyPlaylistItem(sheetItem);

    return {
        isEnd: (startIndex + songs.length) >= (data?.TotalRecordCount ?? 0),
        musicList: songs.map(formatEmbyMusicItem),
        sheetItem: page === 1 ? supplementarySheetData : undefined
    };
}

async function getAllSongsApi(page) {
    const startIndex = (page - 1) * pageSize;
    const params = {
        UserId: embyUserId,
        IncludeItemTypes: 'Audio',
        Recursive: true,
        Fields: 'SortName,MediaSources,ProductionYear,PrimaryImageAspectRatio,BasicSyncInfo',
        EnableImageTypes: 'Primary',
        ImageTypeLimit: 1,
        StartIndex: startIndex,
        Limit: pageSize,
        SortBy: 'SortName',
        SortOrder: 'Ascending'
    };
    const data = await embyApiGet('/Users/' + embyUserId + '/Items', params);
    const songs = data?.Items ?? [];
    return {
        isEnd: (startIndex + songs.length) >= (data?.TotalRecordCount ?? 0),
        musicList: songs.map(formatEmbyMusicItem),
        sheetItem: page === 1 ? { id: ALL_SONGS_TAG.id, title: ALL_SONGS_TAG.title, description: "服务器上的全部音乐" } : undefined
    };
}

async function getLyricApi(musicItem) {
    if (!musicItem || !musicItem.title) {
        return null;
    }
    const params = { title: musicItem.title };
    if (musicItem.artist && !['unknown artist', 'various artists'].includes(musicItem.artist.toLowerCase())) {
        params.artist = musicItem.artist;
    }
    if (musicItem.album && !['unknown album'].includes(musicItem.album.toLowerCase())) {
        params.album = musicItem.album;
    }
    try {
        const response = await axios_1.default.get(`${LYRICS_API_BASE_URL}/lyrics`, { params: params, responseType: 'text', timeout: 10000 });
        if (response.data && typeof response.data === 'string' && response.data.trim()) {
            if (!response.data.toLowerCase().includes('not found') && response.data.length >= 10) {
                 return { rawLrc: response.data };
            }
        }
    } catch (error) {
        // Ignore errors
    }
    return null;
}

async function getRecommendSheetTagsApi() {
    return {
        pinned: [ ALL_SONGS_TAG, ALL_PLAYLISTS_TAG ],
        data: []
    };
}

async function getRecommendSheetsByTagApi(tag, page) {
    if (tag.id === ALL_PLAYLISTS_TAG.id) {
        const startIndex = (page - 1) * pageSize;
        const params = {
            UserId: embyUserId,
            IncludeItemTypes: 'Playlist',
            Recursive: true,
            mediaTypes: 'Audio',
            Fields: 'SortName,CanDelete,PrimaryImageAspectRatio,BasicSyncInfo,ChildCount',
            EnableImageTypes: 'Primary',
            ImageTypeLimit: 1,
            StartIndex: startIndex,
            Limit: pageSize,
            SortBy: 'SortName',
            SortOrder: 'Ascending'
        };
        const data = await embyApiGet('/Users/' + embyUserId + '/Items', params);
        const playlists = data?.Items ?? [];
        return {
            isEnd: (startIndex + playlists.length) >= (data?.TotalRecordCount ?? 0),
            data: playlists.map(formatEmbyPlaylistItem)
        };
    } else if (tag.id === ALL_SONGS_TAG.id) {
        if (page > 1) {
            return { isEnd: true, data: [] };
        }
        const fakeSheet = {
            id: ALL_SONGS_TAG.id,
            title: ALL_SONGS_TAG.title,
            artist: "Emby",
            artwork: null,
            description: "浏览服务器上的所有歌曲"
        };
        return { isEnd: true, data: [fakeSheet] };
    } else {
        return { isEnd: true, data: [] };
    }
}

async function getMediaSourceApi(musicItem, quality) {
    if (musicItem._source !== 'emby' && musicItem._source !== 'emby_ncm_artwork') {
        console.warn(`Emby Plugin: Cannot get media source for item with source: ${musicItem._source}. ID: ${musicItem.id}`);
        return null;
    }
    await ensureEmbyLogin();

    const streamUrl = `${embyHost}/Audio/${musicItem.id}/stream?static=true&api_key=${embyAccessToken}`;
    console.log(`Emby Plugin: Generated stream URL for ID ${musicItem.id}: ${streamUrl}`);
    return { url: streamUrl };
}

async function getMusicInfoApi(musicItem) {
    if (musicItem._source === 'emby_ncm_artwork') {
        console.log(`Emby Plugin: Keeping existing (NCM) artwork for item ID: ${musicItem.id}`);
        return { artwork: musicItem.artwork };
    }

    if (musicItem.artwork && typeof musicItem.artwork === 'string' && musicItem.artwork.startsWith('mf-')) {
        console.log(`Emby Plugin: Found MusicFree artwork cache identifier for item ID: ${musicItem.id}. Skipping fetch.`);
        return { artwork: musicItem.artwork };
    }

    if (musicItem._source === 'ncm-import' || musicItem._source === 'ncm') {
         console.log("Emby Plugin: (Fallback) Skipping external cover fetch for NCM item.");
         return { artwork: musicItem.artwork };
    }

    if (!musicItem || !musicItem.title) {
        return null;
    }
    try {
        const params = new URLSearchParams();
        params.append('title', musicItem.title);
        if (musicItem.artist && !['unknown artist', 'various artists'].includes(musicItem.artist.toLowerCase())) {
            params.append('artist', musicItem.artist);
        }
        if (musicItem.album && !['unknown album'].includes(musicItem.album.toLowerCase())) {
            params.append('album', musicItem.album);
        }
        const coverApiUrl = `${LYRICS_API_BASE_URL}/cover?${params.toString()}`;
        console.log(`Emby Plugin: Fetching external cover art for Emby item ${musicItem.id}: ${coverApiUrl}`);
        return { artwork: coverApiUrl };
    } catch (e) {
        console.error(`Emby Plugin: Failed to construct/fetch external cover URL - ${e.message}`);
        return null;
    }
}

async function getNcmTrackDetails(trackIds) {
    if (!trackIds || trackIds.length === 0) {
        return [];
    }
    const ncmHeaders = { Referer: "https://music.163.com/", Origin: "https://music.163.com/", "User-Agent": "Mozilla/5.0" };
    const apiUrl = `https://music.163.com/api/song/detail/?ids=[${trackIds.join(",")}]`;
    try {
        const response = await axios_1.default.get(apiUrl, { headers: ncmHeaders, timeout: 15000 });
        if (response.data?.songs?.length > 0) {
            return response.data.songs.map(formatNcmMusicItem);
        }
        console.warn("NCM Import: Invalid response from /api/song/detail", response.data);
        return [];
    } catch (e) {
        console.error(`NCM Import: Failed to fetch track details - ${e.message}`);
        return [];
    }
}

async function getNcmPlaylistTrackIds(id) {
    const ncmHeaders = { Referer: "https://music.163.com/", Origin: "https://music.163.com/", "User-Agent": "Mozilla/5.0" };
    const apiUrl = `https://music.163.com/api/v3/playlist/detail?id=${id}&n=100000`;
    try {
        const response = await axios_1.default.get(apiUrl, { headers: ncmHeaders, timeout: 15000 });
        if (response.data?.playlist?.trackIds) {
            return response.data.playlist.trackIds.map((_) => _.id);
        }
        console.error("NCM Import: Invalid response from /api/v3/playlist/detail", response.data);
        throw new Error("无法获取网易云歌单详情。");
    } catch (e) {
        console.error(`NCM Import: Failed to get playlist track IDs for ${id} - ${e.message}`);
        throw new Error(`获取网易云歌单信息失败: ${e.message}`);
    }
}

async function findAndMergeNcmTrackOnEmby(ncmTrack) {
    const query = `${ncmTrack.title} ${ncmTrack.artist}`;
    console.log(`NCM Import: Searching Emby for "${query}" (NCM ID: ${ncmTrack._ncmId})`);

    try {
        const searchResult = await searchMusic(query, 1, NCM_MATCH_RESULT_COUNT);

        if (!searchResult.data || searchResult.data.length === 0) {
            console.log(`NCM Import: No Emby results found for "${query}"`);
            return null;
        }

        let bestMatch = null;
        let bestMatchScore = -1;

        for (const embyTrack of searchResult.data) {
            let currentScore = 0;
            let titleMatch = (embyTrack.title.toLowerCase() === ncmTrack.title.toLowerCase());
            let artistMatch = (embyTrack.artist.toLowerCase() === ncmTrack.artist.toLowerCase());
            let durationMatch = false;

            if (titleMatch) {
                currentScore += 10;
            }
            if (artistMatch) {
                currentScore += 5;
            }
            if (typeof embyTrack.duration === 'number' && typeof ncmTrack.duration === 'number') {
                if (Math.abs(embyTrack.duration - ncmTrack.duration) <= DURATION_TOLERANCE_SECONDS) {
                    durationMatch = true;
                    currentScore += 8;
                }
            }

            if (titleMatch && artistMatch && durationMatch) {
                 console.log(`NCM Import: Found PERFECT Emby match for "${ncmTrack.title}": ID ${embyTrack.id} (T+A+D)`);
                 bestMatch = embyTrack;
                 break;
            }
            if (titleMatch && artistMatch && bestMatchScore < 15) {
                 console.log(`NCM Import: Found GOOD Emby match for "${ncmTrack.title}": ID ${embyTrack.id} (T+A)`);
                 bestMatch = embyTrack;
                 bestMatchScore = 15;
            }
             if (titleMatch && durationMatch && bestMatchScore < 10) {
                 console.log(`NCM Import: Found DECENT Emby match for "${ncmTrack.title}": ID ${embyTrack.id} (T+D)`);
                 bestMatch = embyTrack;
                 bestMatchScore = 10;
             }
        }

        if (bestMatch) {
            const finalTrackItem = {
                id: bestMatch.id,
                title: bestMatch.title,
                artist: bestMatch.artist,
                album: bestMatch.album,
                artwork: ncmTrack.artwork,
                duration: bestMatch.duration,
                _source: 'emby_ncm_artwork'
            };
            return finalTrackItem;
        } else {
            console.log(`NCM Import: No confident Emby match found for "${ncmTrack.title}" by ${ncmTrack.artist}`);
            return null;
        }
    } catch (e) {
        console.error(`NCM Import: Error during Emby matching process for "${ncmTrack.title}": ${e.message}`);
        return null;
    }
}

async function processNcmPlaylistImport(id) {
    const trackIds = await getNcmPlaylistTrackIds(id);
    if (trackIds.length === 0) {
        return [];
    }
    let ncmTracks = [];
    const batchSizeNcm = 200;
    for (let i = 0; i < trackIds.length; i += batchSizeNcm) {
        const batchIds = trackIds.slice(i, i + batchSizeNcm);
        const batchResult = await getNcmTrackDetails(batchIds);
        ncmTracks = ncmTracks.concat(batchResult);
    }

    const matchedEmbyTracks = [];
    const searchPromises = [];
    let completedCount = 0;

    for (const ncmTrack of ncmTracks) {
        const searchPromise = findAndMergeNcmTrackOnEmby(ncmTrack)
            .then(mergedTrack => {
                completedCount++;
                if (completedCount % 10 === 0 || completedCount === ncmTracks.length) {
                    console.log(`NCM Import: Match progress: ${completedCount}/${ncmTracks.length}`);
                }
                return mergedTrack;
            })
            .catch(err => {
                console.error(`NCM Import: Error in individual search promise for "${ncmTrack.title}": ${err.message}`);
                return null;
            });
        searchPromises.push(searchPromise);

        if (searchPromises.length >= NCM_IMPORT_CONCURRENCY) {
            const results = await Promise.all(searchPromises);
            results.forEach(track => { if (track) { matchedEmbyTracks.push(track); }});
            searchPromises.length = 0;
        }
    }
    if (searchPromises.length > 0) {
        const results = await Promise.all(searchPromises);
        results.forEach(track => { if (track) { matchedEmbyTracks.push(track); }});
    }
    console.log(`NCM Import: Finished matching. Found ${matchedEmbyTracks.length} corresponding tracks on Emby out of ${ncmTracks.length}.`);
    return matchedEmbyTracks;
}

async function importNcmSheet(urlLike) {
    const matchResult = urlLike.match(/(?:https:\/\/y\.music\.163.com\/m\/playlist\?id=([0-9]+))|(?:https?:\/\/music\.163\.com\/playlist\/([0-9]+)\/.*)|(?:https?:\/\/music.163.com(?:\/#)?\/playlist\?id=(\d+))|(?:^\s*(\d+)\s*$)/);
    if (!matchResult) {
        throw new Error("无法识别的网易云歌单链接或 ID 格式。");
    }
    const id = matchResult[1] || matchResult[2] || matchResult[3] || matchResult[4];
    if (!id) {
        throw new Error("无法从输入中提取有效的网易云歌单 ID。");
    }
    return await processNcmPlaylistImport(id);
}

module.exports = {
    platform: "Emby",
    version: "1.0.0",
    author: 'AI Assistant',
    srcUrl: "",
    cacheControl: "no-cache",

    userVariables: [
        { key: "url", name: "Emby 服务器地址", desc: "例如: http://192.168.1.100:8096" },
        { key: "username", name: "Emby 用户名" },
        { key: "password", name: "Emby 密码", type: 'password' },
    ],
    supportedSearchType: ["music", "album", "artist", "sheet"],

    hints: {
        importMusicSheet: [ "支持导入网易云歌单。", "导入时会尝试在您的 Emby 服务器上查找匹配歌曲。", "【重要】导入速度取决于歌单大小和服务器响应，可能需几分钟。", "【重要】只有成功匹配的歌曲会被导入，且保留网易云封面。", "匹配基于歌曲名+歌手名+时长，请核对结果。", "请输入网易云歌单分享链接或纯数字 ID。" ], importMusicItem: []
    },

    async search(query, page, type) {
         try {
             if (type === "music") { return await searchMusic(query, page); }
             if (type === "album") { return await searchAlbum(query, page); }
             if (type === "artist") { return await searchArtist(query, page); }
             if (type === "sheet") { return await searchSheet(query, page); }
             console.warn(`Emby Plugin: Unsupported search type "${type}"`);
             return { isEnd: true, data: [] };
         } catch (e) {
             console.error(`Emby Plugin: Exported search failed - ${e.message}`);
             return { isEnd: true, data: [] };
         }
    },
    async getAlbumInfo(albumItem, page) {
         try {
             return await getAlbumInfoApi(albumItem, page);
         } catch (e) {
             console.error(`Emby Plugin: Exported getAlbumInfo failed - ${e.message}`);
             return { isEnd: true, musicList: [] };
         }
    },
    async getMusicSheetInfo(sheetItem, page) {
         try {
             return await getMusicSheetInfoApi(sheetItem, page);
         } catch (e) {
             console.error(`Emby Plugin: Exported getMusicSheetInfo failed - ${e.message}`);
             return { isEnd: true, musicList: [] };
         }
    },
    async getMediaSource(musicItem, quality) {
        console.log(`Emby Plugin: EXPORTED getMediaSource called - ID: ${musicItem.id}, Source: ${musicItem._source}`);
        try {
            return await getMediaSourceApi(musicItem, quality);
        } catch (e) {
            console.error(`Emby Plugin: Exported getMediaSource failed - ${e.message}`);
            return null;
        }
    },
    async getLyric(musicItem) {
        try {
            return await getLyricApi(musicItem);
        } catch (e) {
            console.error(`Emby Plugin: Exported getLyric failed - ${e.message}`);
            return null;
        }
    },
    async getRecommendSheetTags() {
        try {
            return await getRecommendSheetTagsApi();
        } catch (e) {
            console.error(`Emby Plugin: Exported getRecommendSheetTags failed - ${e.message}`);
            return { pinned: [], data: [] };
        }
    },
    async getRecommendSheetsByTag(tag, page) {
         try {
             return await getRecommendSheetsByTagApi(tag, page);
         } catch (e) {
             console.error(`Emby Plugin: Exported getRecommendSheetsByTag failed - ${e.message}`);
             return { isEnd: true, data: [] };
         }
    },
    async getMusicInfo(musicItem) {
        console.log(`Emby Plugin: EXPORTED getMusicInfo called - ID: ${musicItem.id}, Source: ${musicItem._source}, Artwork: ${musicItem.artwork}`);
        try {
             return await getMusicInfoApi(musicItem);
        } catch (e) {
            console.error(`Emby Plugin: Exported getMusicInfo failed - ${e.message}`);
            return null;
        }
    },
    async importMusicSheet(urlLike) {
        console.log("Emby Plugin: EXPORTED importMusicSheet called (v1.0.0)");
        try {
            return await importNcmSheet(urlLike);
        } catch (e) {
             console.error(`Emby Plugin: Exported importMusicSheet failed - ${e.message}`);
             throw e;
        }
    }
};