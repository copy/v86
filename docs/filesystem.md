A 9p filesystem is supported by v86, using a virtio transport. Using
it, files can be exchanged with the guest OS, see `create_file` and `read_file`
in [`starter.js`](https://github.com/copy/v86/blob/master/src/browser/starter.js).
It can be enabled by passing the following options to `V86`:

```javascript
filesystem: {
    basefs: "../9p/fs.json",
    baseurl: "../9p/base/",
}
```

Here, `basefs` is a json file created using
[fs2json](https://github.com/copy/fs2json). The base url is the prefix of a url
from which the files are available. For instance, if the 9p filesystem has a
file `/bin/sh`, that file must be accessible from
`http://localhost/9p/base/bin/sh`. If `basefs` and `baseurl` are omitted, an
empty 9p filesystem is created.

The `mount_tag` of the 9p device is `host9p`. In order to mount it in the
guest, use:

```sh
mount -t 9p host9p /mnt/9p/
```
