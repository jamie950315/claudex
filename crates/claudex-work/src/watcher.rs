use anyhow::Result;
use std::{
    fs::File,
    io::Write,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::net::UnixStream,
    },
    path::Path,
};
/// One blocking native event source with a separate shutdown descriptor. A kqueue
/// cannot be registered in Tokio's own kqueue, so it has a dedicated sleeping thread.
pub struct DirectoryEvents {
    receiver: tokio::sync::mpsc::Receiver<std::io::Result<()>>,
    stop: UnixStream,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl DirectoryEvents {
    pub fn open(path: &Path) -> Result<Self> {
        let directory = File::open(path)?;
        let (stop, stopping) = UnixStream::pair()?;
        #[cfg(target_os = "macos")]
        let queue = unsafe {
            let fd = libc::kqueue();
            if fd < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            let queue = OwnedFd::from_raw_fd(fd);
            let changes = [
                libc::kevent {
                    ident: directory.as_raw_fd() as _,
                    filter: libc::EVFILT_VNODE,
                    flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_CLEAR,
                    fflags: libc::NOTE_WRITE | libc::NOTE_DELETE | libc::NOTE_RENAME,
                    data: 0,
                    udata: std::ptr::null_mut(),
                },
                libc::kevent {
                    ident: stopping.as_raw_fd() as _,
                    filter: libc::EVFILT_READ,
                    flags: libc::EV_ADD | libc::EV_ENABLE,
                    data: 0,
                    fflags: 0,
                    udata: std::ptr::null_mut(),
                },
            ];
            if libc::kevent(
                fd,
                changes.as_ptr(),
                2,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            ) < 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            queue
        };
        #[cfg(not(target_os = "macos"))]
        let queue = unsafe {
            use std::os::unix::ffi::OsStrExt;
            let fd = libc::inotify_init1(libc::IN_CLOEXEC);
            if fd < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            let queue = OwnedFd::from_raw_fd(fd);
            let path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
            if libc::inotify_add_watch(
                fd,
                path.as_ptr(),
                libc::IN_CLOSE_WRITE
                    | libc::IN_MOVED_TO
                    | libc::IN_DELETE
                    | libc::IN_DELETE_SELF
                    | libc::IN_MOVE_SELF,
            ) < 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            queue
        };
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        let thread = std::thread::Builder::new()
            .name("claudex-stop-watch".into())
            .spawn(move || {
                let _directory = directory;
                loop {
                    #[cfg(target_os = "macos")]
                    let result = unsafe {
                        let mut event = std::mem::MaybeUninit::<libc::kevent>::uninit();
                        let count = libc::kevent(
                            queue.as_raw_fd(),
                            std::ptr::null(),
                            0,
                            event.as_mut_ptr(),
                            1,
                            std::ptr::null(),
                        );
                        if count < 0 {
                            Err(std::io::Error::last_os_error())
                        } else {
                            let event = event.assume_init();
                            if event.ident == stopping.as_raw_fd() as usize {
                                break;
                            }
                            Ok(())
                        }
                    };
                    #[cfg(not(target_os = "macos"))]
                    let result = unsafe {
                        let mut fds = [
                            libc::pollfd {
                                fd: queue.as_raw_fd(),
                                events: libc::POLLIN,
                                revents: 0,
                            },
                            libc::pollfd {
                                fd: stopping.as_raw_fd(),
                                events: libc::POLLIN,
                                revents: 0,
                            },
                        ];
                        if libc::poll(fds.as_mut_ptr(), 2, -1) < 0 {
                            Err(std::io::Error::last_os_error())
                        } else if fds[1].revents != 0 {
                            break;
                        } else {
                            let mut b = [0u8; 4096];
                            if libc::read(queue.as_raw_fd(), b.as_mut_ptr() as _, b.len()) < 0 {
                                Err(std::io::Error::last_os_error())
                            } else {
                                Ok(())
                            }
                        }
                    };
                    let failed = result.is_err();
                    if sender.try_send(result).is_err() && sender.is_closed() {
                        break;
                    }
                    if failed {
                        break;
                    }
                }
            })?;
        Ok(Self {
            receiver,
            stop,
            thread: Some(thread),
        })
    }
    pub async fn changed(&mut self) -> Result<()> {
        self.receiver
            .recv()
            .await
            .ok_or_else(|| anyhow::anyhow!("Application marker watcher stopped."))??;
        Ok(())
    }
}
impl Drop for DirectoryEvents {
    fn drop(&mut self) {
        let _ = self.stop.write_all(&[1]);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
