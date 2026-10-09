package main

// Native adapters supply these facts from opened handles and token-derived
// SIDs. Portable tests exercise the actual policy used by the Win32 adapter.
type aceFact struct {
	kind, flags              byte
	mask                     uint32
	current, system, trusted bool
}

const dangerousAncestorRights uint32 = 0x10000 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000 | 0x40 | 0x100 | 0x10

func descriptorPolicy(ownerTrusted, ownerCurrent, protected, private bool, aces []aceFact) error {
	if (!private && !ownerTrusted) || (private && (!ownerCurrent || !protected)) || len(aces) == 0 {
		return refused
	}
	for _, a := range aces {
		if !private && a.flags&8 != 0 {
			continue
		}
		if !private && a.kind == 1 {
			continue
		}
		if a.kind != 0 || (private && a.flags != 0) {
			return refused
		}
		if private {
			if !a.current && !a.system {
				return refused
			}
		} else if a.mask&dangerousAncestorRights != 0 && !a.trusted {
			return refused
		}
	}
	return nil
}
func filePolicy(reparse, directory, wantDirectory bool, links uint32, disk bool) error {
	if reparse || directory != wantDirectory || (!directory && links != 1) || !disk {
		return refused
	}
	return nil
}

// FILE_WRITE_DATA and FILE_APPEND_DATA mutate a final executable, but the
// same bits on an ancestor directory merely allow adding new children.
func executablePolicy(ownerTrusted, ownerCurrent, protected, private bool, aces []aceFact) error {
	if err := descriptorPolicy(ownerTrusted, ownerCurrent, protected, private, aces); err != nil {
		return err
	}
	for _, a := range aces {
		if a.kind == 0 && a.flags&8 == 0 && !a.trusted && a.mask&(0x2|0x4) != 0 {
			return refused
		}
	}
	return nil
}
