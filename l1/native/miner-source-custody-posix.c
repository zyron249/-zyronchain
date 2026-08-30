#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif
#ifndef O_NOFOLLOW
#define O_NOFOLLOW 0
#endif
#ifndef O_DIRECTORY
#define O_DIRECTORY 0
#endif

#define MAX_COMPONENTS 64
#define MAX_PATH_BYTES 4096
#define READ_BUFFER_SIZE 65536

static void die(const char *what) {
  fprintf(stderr, "miner-source-custody-posix: %s: %s\n", what, strerror(errno));
  exit(1);
}

static int open_root_nofollow(const char *path) {
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) die("open source root");
  return fd;
}

static int valid_component(const char *component) {
  if (!component || !*component) return 0;
  if (strcmp(component, ".") == 0 || strcmp(component, "..") == 0) return 0;
  return strchr(component, '/') == NULL;
}

static int open_relative_regular_nofollow(int root_fd, const char *relative_path) {
  if (!relative_path || !*relative_path || relative_path[0] == '/' || strlen(relative_path) >= MAX_PATH_BYTES) {
    errno = EINVAL;
    die("invalid relative source path");
  }

  char path[MAX_PATH_BYTES];
  memcpy(path, relative_path, strlen(relative_path) + 1);

  int current_fd = dup(root_fd);
  if (current_fd < 0) die("dup source root");

  size_t components = 0;
  char *saveptr = NULL;
  char *component = strtok_r(path, "/", &saveptr);
  if (!component) {
    close(current_fd);
    errno = EINVAL;
    die("empty relative source path");
  }

  for (;;) {
    components++;
    if (components > MAX_COMPONENTS || !valid_component(component)) {
      close(current_fd);
      errno = EINVAL;
      die("invalid relative source component");
    }

    char *next = strtok_r(NULL, "/", &saveptr);
    if (!next) {
      int file_fd = openat(current_fd, component, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
      int saved = errno;
      close(current_fd);
      errno = saved;
      if (file_fd < 0) die("open relative source file");

      struct stat st;
      if (fstat(file_fd, &st) != 0) {
        int stat_saved = errno;
        close(file_fd);
        errno = stat_saved;
        die("fstat relative source file");
      }
      if (!S_ISREG(st.st_mode)) {
        close(file_fd);
        errno = EINVAL;
        die("relative source is not a regular file");
      }
      return file_fd;
    }

    int next_fd = openat(current_fd, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int saved = errno;
    close(current_fd);
    errno = saved;
    if (next_fd < 0) die("open relative source directory");
    current_fd = next_fd;
    component = next;
  }
}

static void assert_root_identity(int root_fd, const struct stat *before) {
  struct stat after;
  if (fstat(root_fd, &after) != 0) die("fstat bound source root");
  if (before->st_dev != after.st_dev || before->st_ino != after.st_ino) {
    fprintf(stderr, "miner-source-custody-posix: bound source root identity changed\n");
    exit(70);
  }
}

static void stream_file(int fd) {
  unsigned char buffer[READ_BUFFER_SIZE];
  for (;;) {
    ssize_t got = read(fd, buffer, sizeof(buffer));
    if (got < 0) {
      if (errno == EINTR) continue;
      die("read relative source file");
    }
    if (got == 0) return;
    size_t offset = 0;
    while (offset < (size_t)got) {
      ssize_t wrote = write(STDOUT_FILENO, buffer + offset, (size_t)got - offset);
      if (wrote < 0) {
        if (errno == EINTR) continue;
        die("write source bytes");
      }
      if (wrote == 0) {
        errno = EIO;
        die("write source bytes");
      }
      offset += (size_t)wrote;
    }
  }
}

int main(int argc, char **argv) {
  if (argc != 4 || (strcmp(argv[1], "read") != 0 && strcmp(argv[1], "hold-read") != 0)) {
    fprintf(stderr, "usage: %s <read|hold-read> <source-root> <relative-file>\n", argv[0]);
    return 64;
  }

  int root_fd = open_root_nofollow(argv[2]);
  struct stat root_before;
  if (fstat(root_fd, &root_before) != 0) die("fstat source root");

  if (strcmp(argv[1], "hold-read") == 0) {
    puts("BOUND");
    fflush(stdout);
    int ch = getchar();
    if (ch == EOF) {
      fprintf(stderr, "miner-source-custody-posix: coordination input closed\n");
      close(root_fd);
      return 65;
    }
  }

  int file_fd = open_relative_regular_nofollow(root_fd, argv[3]);
  assert_root_identity(root_fd, &root_before);
  stream_file(file_fd);

  if (close(file_fd) != 0) die("close relative source file");
  assert_root_identity(root_fd, &root_before);
  if (close(root_fd) != 0) die("close source root");
  return 0;
}
