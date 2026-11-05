/*
 * Copyright 2019 Paul Gofman
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA 02110-1301, USA
 */

#ifndef __WINE_D3D9_TESTS_UTILS_H
#define __WINE_D3D9_TESTS_UTILS_H

#include "wine/test.h"

#define wait_query(a) wait_query_(__FILE__, __LINE__, a)
static inline void wait_query_(const char *file, unsigned int line, IDirect3DQuery9 *query)
{
    unsigned int i;
    HRESULT hr;

    for (i = 0; i < 500; ++i)
    {
        if ((hr = IDirect3DQuery9_GetData(query, NULL, 0, D3DGETDATA_FLUSH)) == S_OK)
            break;
        Sleep(10);
    }
    ok_(file, line)(hr == S_OK, "Got unexpected hr %#lx.\n", hr);
}

#endif
