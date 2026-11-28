use std::fs::File;
use std::io::Read;

use fd_core::{FsError, JsNumber};
use rustix::fs::{FileType, fstat};

use crate::entry::mtime_ms;
use crate::map_errno;
use crate::resolve::{Root, resolve_read};

/// A file opened for reading, checked on its descriptor.
#[derive(Debug)]
pub struct OpenedFile {
    /// The canonical virtual path
    pub virtual_path: String,
    /// The last name of the real path (after links), for the download name
    pub name: String,
    pub file: File,
    pub size: u64,
    pub mtime_ms: f64,
    pub mime: &'static str,
}

const MIME: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("avif", "image/avif"),
    ("svg", "image/svg+xml"),
    ("bmp", "image/bmp"),
    ("ico", "image/x-icon"),
    ("mp4", "video/mp4"),
    ("m4v", "video/mp4"),
    ("webm", "video/webm"),
    ("mkv", "video/x-matroska"),
    ("mov", "video/quicktime"),
    ("mp3", "audio/mpeg"),
    ("m4a", "audio/mp4"),
    ("ogg", "audio/ogg"),
    ("wav", "audio/wav"),
    ("flac", "audio/flac"),
    ("opus", "audio/ogg"),
    ("pdf", "application/pdf"),
    ("json", "application/json"),
    ("html", "text/plain"),
    ("htm", "text/plain"),
    ("txt", "text/plain"),
    ("md", "text/plain"),
    ("log", "text/plain"),
    ("csv", "text/plain"),
    ("xml", "text/plain"),
    ("yaml", "text/plain"),
    ("yml", "text/plain"),
    ("ts", "text/plain"),
    ("js", "text/plain"),
    ("css", "text/plain"),
];

/// The content type for a file name. Page types are served as plain text so a browser never runs them.
pub fn mime_for(name: &str) -> &'static str {
    // Like the TypeScript agent: the text after the last dot, or the whole name when there is no dot.
    let ext = name.rsplit('.').next().unwrap_or(name).to_lowercase();
    MIME.iter()
        .find(|(e, _)| *e == ext)
        .map_or("application/octet-stream", |(_, m)| m)
}

/// Open a file for `read` and `download`: confined, never a folder, never a special file.
pub fn open_file(root: &Root, path: &str) -> Result<OpenedFile, FsError> {
    let r = resolve_read(root, path)?;
    let fd = r.open_read()?;
    let st = fstat(&fd).map_err(map_errno)?;
    match FileType::from_raw_mode(st.st_mode) {
        FileType::RegularFile => {}
        FileType::Directory => return Err(FsError::bad_request("is a directory")),
        _ => return Err(FsError::bad_request("not a regular file")),
    }
    let name = r.name_lossy();
    Ok(OpenedFile {
        mime: mime_for(&name),
        name,
        virtual_path: r.virtual_path.clone(),
        file: File::from(fd),
        size: u64::try_from(st.st_size).unwrap_or(0),
        mtime_ms: mtime_ms(&st),
    })
}

/// What a `Range` header asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeSpec {
    /// No header: the whole file
    Whole,
    /// A header that cannot be met (416)
    Invalid,
    /// First and last byte, both inside the file
    Bytes { start: u64, end: u64 },
}

/// The single byte range of a header, as the TypeScript `parseRange` reads it.
pub fn parse_range(header: Option<&str>, size: u64) -> RangeSpec {
    let Some(h) = header.filter(|h| !h.is_empty()) else {
        return RangeSpec::Whole;
    };
    let Some(spec) = h.trim().strip_prefix("bytes=") else {
        return RangeSpec::Invalid;
    };
    let Some((a, b)) = spec.split_once('-') else {
        return RangeSpec::Invalid;
    };
    let digits = |s: &str| s.bytes().all(|c| c.is_ascii_digit());
    if !digits(a) || !digits(b) || (a.is_empty() && b.is_empty()) || size == 0 {
        return RangeSpec::Invalid;
    }
    let num = |s: &str| s.parse::<u64>().unwrap_or(u64::MAX);
    let (start, end) = if a.is_empty() {
        let n = num(b);
        if n == 0 {
            return RangeSpec::Invalid;
        }
        (size.saturating_sub(n), size - 1)
    } else {
        (
            num(a),
            if b.is_empty() {
                size - 1
            } else {
                num(b).min(size - 1)
            },
        )
    };
    if start >= size || start > end {
        return RangeSpec::Invalid;
    }
    RangeSpec::Bytes { start, end }
}

/// A time as an HTTP date (`Wed, 01 Jan 2025 00:00:00 GMT`), cut to whole seconds like `Date.toUTCString`.
#[allow(clippy::cast_possible_truncation)]
pub fn http_date(ms: f64) -> String {
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let secs = (ms / 1000.0).floor() as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let weekday = (days + 4).rem_euclid(7);
    format!(
        "{}, {:02} {} {:04} {:02}:{:02}:{:02} GMT",
        DAYS[usize::try_from(weekday).unwrap_or(0)],
        day,
        MONTHS[usize::try_from(month - 1).unwrap_or(0)],
        year,
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// The answer of `GET /api/fs/text`.
#[derive(Debug)]
pub struct TextFile {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub mtime: JsNumber,
    pub etag: String,
}

/// Read a small UTF-8 text file for the editor, with the etag that conflict checks use.
pub fn read_text(root: &Root, path: &str, max_bytes: u64) -> Result<TextFile, FsError> {
    let r = resolve_read(root, path)?;
    let fd = r.open_read()?;
    let st = fstat(&fd).map_err(map_errno)?;
    match FileType::from_raw_mode(st.st_mode) {
        FileType::RegularFile => {}
        FileType::Directory => return Err(FsError::bad_request("is a directory")),
        _ => return Err(FsError::bad_request("not a regular file")),
    }
    let size = u64::try_from(st.st_size).unwrap_or(0);
    if size > max_bytes {
        return Err(FsError::new(413, "file too large to edit"));
    }
    let mut bytes = Vec::new();
    File::from(fd).read_to_end(&mut bytes).map_err(|e| {
        e.raw_os_error().map_or_else(
            || FsError::new(500, "internal error"),
            |n| map_errno(rustix::io::Errno::from_raw_os_error(n)),
        )
    })?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err(FsError::new(415, "binary file"));
    }
    let content =
        String::from_utf8(bytes).map_err(|_| FsError::new(415, "file is not valid UTF-8 text"))?;
    let mtime = mtime_ms(&st);
    Ok(TextFile {
        path: r.virtual_path.clone(),
        content,
        size,
        mtime: JsNumber(mtime),
        etag: format!("{}-{}-{}", JsNumber(mtime), size, st.st_ino),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_cases_match_the_typescript_agent() {
        let b = |start, end| RangeSpec::Bytes { start, end };
        assert_eq!(parse_range(Some("bytes=0-9"), 100), b(0, 9));
        assert_eq!(parse_range(Some("bytes=90-"), 100), b(90, 99));
        assert_eq!(parse_range(Some("bytes=-10"), 100), b(90, 99));
        assert_eq!(parse_range(Some("bytes=0-999"), 100), b(0, 99));
        assert_eq!(parse_range(Some("bytes=100-"), 100), RangeSpec::Invalid);
        assert_eq!(parse_range(Some("nonsense"), 100), RangeSpec::Invalid);
        assert_eq!(parse_range(None, 100), RangeSpec::Whole);
        assert_eq!(parse_range(Some("bytes=-0"), 100), RangeSpec::Invalid);
        assert_eq!(parse_range(Some("bytes=-"), 100), RangeSpec::Invalid);
        assert_eq!(parse_range(Some("bytes=0-1,5-6"), 100), RangeSpec::Invalid);
        assert_eq!(parse_range(Some("bytes=5-2"), 100), RangeSpec::Invalid);
        assert_eq!(parse_range(Some("bytes=0-0"), 0), RangeSpec::Invalid);
        assert_eq!(parse_range(Some(" bytes=0-1 "), 100), b(0, 1));
    }

    #[test]
    fn dates() {
        assert_eq!(http_date(0.0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(
            http_date(1_700_000_000_999.0),
            "Tue, 14 Nov 2023 22:13:20 GMT"
        );
        assert_eq!(
            http_date(951_782_400_000.0),
            "Tue, 29 Feb 2000 00:00:00 GMT"
        );
    }

    #[test]
    fn mime() {
        assert_eq!(mime_for("a.PNG"), "image/png");
        assert_eq!(mime_for("a.html"), "text/plain");
        assert_eq!(mime_for("a.bin"), "application/octet-stream");
        assert_eq!(mime_for("noext"), "application/octet-stream");
    }
}
