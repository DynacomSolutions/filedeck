use fd_core::FsError;
use rustix::io::Errno;

/// The status and text for an operating system error, as the TypeScript `mapError` gives them.
pub fn map_errno(e: Errno) -> FsError {
    let (status, message) = if e == Errno::NOENT {
        (404, "not found")
    } else if e == Errno::NOTDIR {
        (400, "not a directory")
    } else if e == Errno::ISDIR {
        (400, "is a directory")
    } else if e == Errno::EXIST || e == Errno::NOTEMPTY {
        (409, "already exists")
    } else if e == Errno::ACCESS || e == Errno::PERM || e == Errno::ROFS {
        (403, "permission denied")
    } else if e == Errno::NOSPC {
        (507, "no space left on device")
    } else if e == Errno::XDEV {
        (409, "cross-device operation")
    } else if e == Errno::LOOP {
        (400, "too many symbolic links")
    } else {
        (500, "internal error")
    };
    FsError::new(status, message).with_errno(e.raw_os_error())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table() {
        let t: &[(Errno, u16, &str)] = &[
            (Errno::NOENT, 404, "not found"),
            (Errno::NOTDIR, 400, "not a directory"),
            (Errno::ISDIR, 400, "is a directory"),
            (Errno::EXIST, 409, "already exists"),
            (Errno::NOTEMPTY, 409, "already exists"),
            (Errno::ACCESS, 403, "permission denied"),
            (Errno::PERM, 403, "permission denied"),
            (Errno::ROFS, 403, "permission denied"),
            (Errno::NOSPC, 507, "no space left on device"),
            (Errno::XDEV, 409, "cross-device operation"),
            (Errno::IO, 500, "internal error"),
        ];
        for (e, s, m) in t {
            let got = map_errno(*e);
            assert_eq!((got.status, got.message.as_str()), (*s, *m), "{e:?}");
            assert_eq!(got.errno, Some(e.raw_os_error()));
        }
    }
}
