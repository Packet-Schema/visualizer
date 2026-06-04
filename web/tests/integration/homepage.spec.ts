import { test, expect } from "@playwright/test";

const PSDL_CUSTOM_UDP =
  "N4IgRg9gJgniBcBtUBLKCQGcBOBjEANCAHYCGAtgKYYDKEArnpQAQAKE2ALoSJzAA7V4oANYpi6eOBSdMPYggCMANgC-qgLpEolTLmwp-nFBAVSAgs1z1MnCOWYBVACKsAtABsUIlv1K4fTmYAMw5mTl1jYgBzADoeUOxyUm4pfkwoD3kKIRAAYRs7BxdWHmwIAHcAIRk5eABmACYiADdKbEwTMxAABljGkFUgAA";

// toJson(PRESETS["ipv4"], {}) with top-level keys reversed — same content, different key order.
const PSDL_IPV4_PRESET_NONCANONICAL =
  "N4Igxg9gdgzgLgJwIYEspxiAXAbVAGwAtMtQBrNAE2xAgAcQAaWhrEAKiZCW3KpoQBTAGZdhKQfmpsUhfCAC-zAEa8QFKNJD4UcLgDck-AK6DsAFgVKQCYmo1aho5uMlbCgpJUEIAQgE84QUxrSggwGgBJAAkAGQACSGN0GHiAZgAmAFplXXiAdwgEShgAbni4CDgjeI8vH3jlQOD4gF54mISAdfjzADpFAF0VCEp_bDwQFC19HxgUaC4oJABbMzYANTmFqC44fzp1vk0aXIwli2swJCCAcyLxtn3Drm9hJGN8OA2jUwtmMIRNiRAAK8VmCHm0HiUGMK2UDUAKATxaaCdAoVypOAeWqebwIeLCIorG4VQikon4fAQfIwPq9QlFDog_T9eI4ABKADEAMLxADsAE4AIyDRSMUDTGiyeTMZZrKJxPYHI7qfhsM6YOWXZjXO4PGj4NG3bGvEQfL4_EzrACsAPCUXQPiggjg8WieIasWN2MY8TWSBgxiElBRUHS2TOBSKJXiyOpepa-Q8QjJglx9QJaNjSE0afidCQ_mpXkagluaDp8Rt8QAFO0MgAGRrNGAASgKHnDUAg8XocB2qSQqboQhgaLg5Wx6ZJAA8UCs4fFhTWjNTafFjHQKr3zM2mkFUhBhH26APoFXObyBSKxUpJVoSmAGHLVusQAARADKPJBypepBqicGq6FqIC7FgABsVw3OWBpPCqrwOmwH4YsIPgTigsGhl-Pj6CgYAtDyozpiCEBoG6yIkggZBYjihZgGQroAOSpIcCBZIQ9CMgg-TDpQaC3Ik-CBqkRIEgAihAX70gA8mAYBbhIdHplu7HxJBjSgX2J7TvERq3EgYD-PEAAqKo6fEuEIPhhF9mAQSTvEzYoKkCLwFkIjiXA9JXnyGTmPy5h3hKUxaIIYC7K-CpsAAojyABy_6qg4pygRcWAZDB-oII8IDCCJtxgYCNCxbOdA6GAeTEVAtzBOe4YJVUGIETcOxxvprqpAgEDGEEkLxPMtzLPgiTQHV8DtfkuhcX18SUD1dB0IJBZGUxGD0o2jatD2brxQlWTXIWyhGn6jbCgA9MK237YdSDHUaFTILAdBFHAfrCsKrSQLV9XtYI5U-BIUCEaGtY8rFba-dyfJpMKkEABwhQ-NCVNU-DerVprRe-plVDUmMmoQyX2OqUzoFwmrYPD2Vwblho-sT9pAiAePo51WOEJZemUDcSC3MgKx1nU-IFiYqS89UHZoC2h70gAsmgC5Lk2wuegS0D4P4bblHOytC5BNo2mkNbzCD6Z6a4Ugoqk8NaRgBSotD15CqK4oozI3jouIeo7Esb5RF7A4-21izMM8KVkxRlPpVgNO6rB9z057mGuAgSEs5EQctS0wjILcawpGSpIItStU7vmMBvn2CAoBWI3zXzAurINvZ6UIhEoBCiS5vEQiiYI8KPdOKz0gAgjAQ0uqGTSV9mDS5qGMDkiGLbxGuhL54XDvHn2LqrYxrrO3yrvI0BWgC71L5hTQBX8zAvjpbqhAoFIQgQZMUpsHfRUAPpjnhQQ1AcY0A5CTQCqUQLnG1HHWmSc8o_2KshEAHJgiANDD_Dqi54BlmcsfG8bt7w32_oVGAv9KDOHAgHFCXJwHHC0FTGBwo4HwXyqQjONAPzQGYm6LkW8JwdWTGiZcfoep9TmP6YwODdqb35tvfMDF1rrzzAtbieRaxCDgMGKAK1Ig8nliCaWJ48gA0IkAlSMIAZuh0FAMgrF4jy1MgAVXpE48cM8TIghuFzRxTj4ioRgJACE_h8Guz9DDZcwpbzu2IWw--v8ViUPlO-eWtDw6IQgWTRh4FqYsOTnEoqHC2DyyKOmPhciJypGRMKPe8RBDBNkQXARpjBBnnzCJeAZ1amWzQDUWsTJNba0advP0QQqQrXbhFQQXcGhCPDP3Seg8TomVcmNFYFVXSCFCdEhQgwiFf3yvnWSwhhDjj0CAtg5SmnoHiMc05ro6HnzStAnJcc0h5Lyqib2Eh07MxoGReYDVuYvzEvw9A9jJZIEdtiGWekih116aNSFzcVh-iSE6UMMsEY5GaJuHRG1nI8XzOISEbo84VPQNswhoUDlwDgLKKhMVWamViI8yB5NzkgCplgBGHzpTZzTkU1mC50x43iLEGZHVvBgCENvIBa9oDplJJ4MAXMxH9SnPRNarobbzVctcYo8razTWxMojo-iwSmRFfEMqZjvCUA7HMlEbp-6qpaI2P0o56mYXLuqla1J6CXgiafGJBzRxVHCBABlyT_k9UqJABlEdSbAQ5THc4PK-UIReH84EArlL5hdLOOAWQjSzFGuG-NUae4IFrvK2FWriwQC8PSYiKwVjQkMNaW2rQ9EGL9JBVoplfwfX5K0JxH4QRUr9JEMeCUx7xBBHGyNo0EpwgRJCM-ByRY-B5B4RiQYVj-yZR6TM8Rd0RVonCNlUcKYqFjvHcAidWFuv3VenNIB4Y5DyIq1ih0IDrKNPIl9l6haQHWeI0MEBu56W3RrKAWs6wyL0oWRtXgobxFQWBugEH15uhVVzLi24ETXCkRbHEpkWWJHJL9INLsdk0q0DABAYAx6UAWke98X5erMfTKxhawQwJJsySm6Od702ZEzdwNjY4za3CFaCVk69pMCeBemccmgfBUs3Y-eAfHfmMvfB-P6ywgV6YE9ekTt6uWxwkwnHKeUvD8cnoJeTLJzBKac0eXSOIKLz1DB3FAy0JxaZieyoQhwbhcAOf2QcHGaCyTPLFuzdM8qGFrkgE6ZhmCSEHhONQ0XEvQEwzGMQEgpAkEmOymAJrVVRYYf4cy2baAQXoQIEQpW3A0H7I1swMFxwkFAI2fL4Uo1xbirJBItZYp5l3gloFEr4Btg6-ViYHsQBJouazFUrQhvpIAq1qBYEIK8uS_A1GiF31zfahHWWWzCXUVovmabkGTxXehAtpyuYTKFjYytJAwh-rOs3NuSo-ZYONF6poYcKzUh1x7CGELuzrDCmGzQHs18Y1sASrJMEtYmq3PYqHKAS2XBlZKKt2JG2DM0B660FHe3I4puycdyTVOSpsDe-GG7B47s1NWVCpqWQEs-CJ6tSgaL_3tvgys2APggihlB0YOH69GRUhpCtGL0JoRQsyF-t0yhIe81yojvZzB-So7YB3GMHJepBDGygiKMYMO26y_lMnFW1tU8x1tw4rRzcM-TQwp-ryTuPvs-dpr7OQCc4qBZHn5R-SDRyw5VIxXijO_EX6ZMBEuYJqNCn_MCn3OOZk5ZfDfcXcEh5k3QWT0kAQn64jhjDNOb28xnTm0Fmg8vJZ6d1hRpW_vrZjUAfRNgWrM1-GGWPOYB-jQGAEwAly56Qjn6UfvplGhler5gkM-m9re306fT3uQSIC788o72BQ-JjOynb5PghWyRdDkQM8qec6XuW6UHelC1kqEEq5TSeQaakN0etdMSfcocvK3YoFadVBeSgQwc2WHfXEyNkPyAhbTGgEvXbanNgPTZcc_GQKzblWzMPFLLAwA2TIVNPe1ZkRTEvFTGAEAjqcQKkOtcMWeKFOAgkQMfMZFWvQsRZOiMRW4QgffWJEvenXAkAfAjIQg1NMTEgUgm_VhBg5zWqagx3Q1UMIvDzUvJgqoFg1-I0TFDgkyLgyvdeCxfgluQQ_rMkEQsQ9kYNejNbEvOQzbfAtIeQ0TazcTLKPvfJNQqg99Gg-VXQ4I4Aww5EVgkwsMNeCw8RHg6wmvWwgeYQ3qUQk3awRGC3dbEVeAVYDHahYVNYQo9ZZbcnXAT3C7aQ2nXIgPYTbvS_DNQIvKNnZBGPbnZocoRGJPfPB2PSSII_F0N0K1Mo6odZU8BqLPF-VVPuLQ2MFfa1KAyw6jSgOI6vaoFFcQg5dfJmaQ9vYUDw9bDJA7Pwlo6_J9fJfYoVYfUafY8fI8QrKfMww8OfEGRfCZHEVfDmImT1ciI_P0RePsCEAqGkC6TBPfZwujalA_QE_qe3U_fTITc45nK_STL5YOH5R_Z_ZQV_DxIID_M5CuH_KxTeQQC2AoyY7cAwz7BA3MUGKwupIyNVSw6A2MbSAcCYoo3YrQY8fAfIAqOTTbY5QUi6LkfAEU04_bJ5Q7DKK48PEhe-R_ME9cMaZIN0WsF-UQhkTUDsXebguiUkJIa2GRRzFXbk-qIoz1cWFXcwPXQkQqfoiKAcZfHEDkladtbwOsK08ougI8aXLPGaAsMcQ4KqVwUMYI4IP0V0MAPodDdAkNfZLQDAHA73UyL8Agxo843wkggIsg2_MKVOHEofakooqI0A8MFYYw1yR3TQVIM2OyJxIdf0aYHRUQyiAoWuOlYRTgivJI5krY_mAQ9IhwzIpwpM1wynGAKQjMrMk41EuUhQi47AZQ64z5PNB_MsnkqYuk-Ims8ZccH6WMJs9MFsvkGsygDswgLs_IHsoIMwlXbgocnEGwoWOwlobERw7I5gYUOGPIgNccLjYMQiG3cRNvCACAccKybjOycCu3UnNwD3SnWojM7bf8qQpc9ldE1ows1hDolmLouPHo5cOGF0gvWIKCmCkCnjTfDDRYjPIIWYjCdpVyeXeIQyIIPifwVIbBfXdMfCQFdgmuUWZQOaKoFMWoQNf0IseyRSXfV0fISkrnDwUeGEk-acvYxmNvNEOnLCs45c3CxU8gtgW4offGB4xmJ46Y9qafVsD4hfYwJfISFfFUNfRmYEvMQ_QHaEqcuE2JHy7c6Q5E-Q4yzErc_TKPJ_QQF_dxW7YknVb_HEX_AcokyI0HBEUM8IATIBcoLwRApk2eYvVIcvHQeAeVLiwQHi3VV1DwSgPkighadMko_Agy2U9lPMmzAslQoIyglzd9CIygyyKFKqmq6EPSGAOC2KmAcMnOfzF3RqtgSQ-3WQnw4g7qyTYIgakAKPIazzEazi2Cca1StTaarIWaiKeatKu7fyu8U3D9NIc3QCA5eAWuByWisCl3e3L8RAAiN0T69MBC13K2Koz-VMtCko2nf8_3GUxnZohU1nWo6Kl42PQ4W7coGGiih2X696gG6a-imgpiwQFi1MYclFSRHBLK8SPibQveBDb8ic_MAGIyN0MaosVIcq-XD40SzTDSjA0NLQcyw4vSz6MK4PXvfCm4nSiy9mR43eGFZ4oFey94sMJyly_MX4_YryrfBEhoPylwgKsNPW4_Eo0KnMoyiWjEto_lEs4K6KvEgkhK48T_UklK8kuAvQlTTK9McNQiRZSgfKhk82DxBkXgsq9iyq46uS1ZOqoBJaqTZq1a6TbMuGwPaUDa_wra_qjQwatzL2oA3eUa6OkyCanEKa0CmauayMm6hOlazwlOxcwyzqzOpQnqjcpqmTHava_OyIouo67iuSsus6yui66uiQBa8RbIqwB69FPQJotrShUG6UOgVkTnGAYiTUxQXZAEYIGVQLBqKIfO8HWsQ2jsZEToeaWuWYCxdev47EAYFQZoWSQ1dONgXwWKLgHqfIR-fwzbXQk9fEAwbYRYNgRsPoE48SEkeekAAMjYxQIAA";

// encodePsdlParam(PRESETS["ipv4"]) — generated via tsx at build time.
const PSDL_IPV4_PRESET =
  "N4IgRg9gJgniBcBtUBjAhgFwKYHMICc54QMYAHLEAGhCiwDM0BXAGwwDU0WnL4AWGlAgoEIAJIAFAAQA3LPgDOASwgA7KaqYBbMPKmAUAilK6qjEvpKsCqRgAWWKfbR18U-gS2Ybtr-5YsIAHcFADopPjcCKUkZPjDEACUAMQBhKQB2AE4ARgBdahBjUTlFFVUC1TQtXhB2eWU1AtIKBFAAayVVKFEwJQwFCoQ-AF9hqlRMXAIiEBYsVRw7ArpGVg4uHgQAVkFhUTFTeVUsDCkACSxnPQAZecXbKilqtAUmfCwoI3UAZgAmAFpeqdAgQoNZDAF0NhrIF7O9vA4nC4pPMwVI0F0EVIyGgYAFnFJdDhOqEpFspAAKAC8Ul-AAZCTBoQBKKSw-YaCBSCBkMxqaxoeFkd4KeYYADcWM8AA8lFptFJsuSuAFglImGQbFy-AywEyrNz6NzeWVSYlUhkcvkaEViEpbCwKlUamIztcmuReO1Ot1iECBjRyvxRuMQFCpoRRM1KLsRMQACLmejyMVKSafADK8hkShQBpS0AcEggnVOhk8-Da1jsDhxKDaJwA5NYKPh_rYeZF8IFBVBOjgpCgWC9rO5XABFCAZsIAeRQKA1lmr9nVZFbUgAbIS-tYIEaa1I5jg0CgYFIACqew1SLP4HN57kobASqQMpTWXQKDD_BhjjDxZI0l-Ph0j4a1Cl9WgFBQMgnWqUR4wzFIJA9Fp4G9Loeh3QZ4A3EMJmwPBI2IehhxwANaD2YgAFFpTIFhcz6KQCwWKw-XUAA5CAzAsKEygMQ8TmsfAICYbBFCkZQcEqFhBzUHA2P4wI-g7MSpCgES137bETwbfowjpOkqVUbipGolIOP-dAcTAOZHjpbIAHpsiM8zLOstBbIcDB8AxBQyAIDBHmybIqRQeTFLUFE6PkSxVDzT4KRSajmQAi1vmyDcAA5wNtEAsBQcpA2dUQ3NQr0QA6TC_WwwMEF-fCw0mIiZjmBYlljURz24rhBPa2xrwPKBMDQHBfK0SkkT0eimGsYaMDQVlOkZaEwgAWU6OUFXpSbLmRNQWBgZlJRlLaJo3LYtm-cllHi7yVwsLAWE-d9FS3f02WMLA0rSLI8gKPKMB6lhbn6uCam6hbZNB-5ytacBsPgTKaCqyDSxARrwxa0QvtMcxLHwZYqPEEweKXNxfJwapTGXLxdACBYtSxBRnW5fAlGJGT1JGsaqkkrkD3ePMlBKQcMSkd4RywHQ5gRLQwgAQQUKTjk-PVmdRPQMU-BQfHeNWzxVCnRup_przUWtdJOH7LX-m00dJ_G-MaYr4OIMRHd4zAyjh9CEf6BBkcqn0cdMDGxlQWwlGe94g2QJrCOmURSNGiihDjEAEisbMPjcMiBPlL9CQcOkbb-3LIJT8iAH0RRz7pXZqBJfYwyD_Rw7JMeapOSLItPifjNRG1OJJKdNgT2XUbJHhEsT6ieWbThM056DHsUsTrPT0UxDTOyYil3gwN5VG0sQUjWiQlqNJisGlPMPmXBxjmlU4GNUNpmykNbzwAVTCH_RQGykBITAA1v4_ykImaCEASgwDLjkR4gFFTZCtADSufdq5QHoODBCSQW7B2qv7CiQZO4RwThGGYVd-4ZzWgQBwo8TZinBIqbk6gsCwONlTdet88y8ixMOL89lWFYgsFzCkUQDpHU4abR42B_DaUFgVLAIs9CTwlpcZW0tbJnleuFLQ9ETjfSkOaX6qD7bJwwVobBjdRBrTwTQaM8NUZYQDnVJGoxcjmN7qnAAQrVAhkExqiVgmQrGPcIKpkeoTTqxBizKHYoNKOo416mE_vNNAn07DLQPAQDmnRerpN5loR44UmCHBeuoLKgJ9TqhPvpV8XYRFKEUCvFJ_5jFIPLmg5OlMZz0HoKKDAODiAMK4aYKQfSBknHwc4mqriQAkO-F3ROxEIl4yiUTDO545QOG6lIa4KiBJ0BQO8U2ud1YW3RKcS4KABqz3EpKA8m8ThGDmu-dA-A6CJWUnYbe0Rz7SG2dUMyd8sAfA-KyNRTFJa3INHSR4wp2GpkZvc7SAQeRmk6WYiCUYMCOhscQc8553QOM9PDdu8AsooxDnaMOyyKFRjJTEkmkTyYHmft-OYchZLCm4sICAskPns1ztklcOI8QQGcGEAsWgtBRRkBsA0oUz4X0eBuKk55kLBXSFSH-8YJDwOntEBWHEFbAJEkDcKskOLaF0IoCuoheWWoFcMkAEgLX8vxSQMlfsKVUoCaHIZ9LsbEFhfWV4WhNmiEyoCJiFtmxWQgPouY48w1VgVHosgc9PgwL0AeKarhJGUmXhvXE-IoCpSkFnTN2arkohPANDsmpdDoFmvdXZxLBw-FYpii0XSvEgALSkew4btCuouFcVww6CrpsjaStCoAKVB1mYUOloTu6rOcBpKwt0cBRvdhIWI6IoDbuVokhwooujyENQ64gCh8AoAVie6JCySrEAzKJB9Dgn2nooo431iM_jUsIejYN4St0il3fu8Qh6IgQZ3eer42Ar2fCFkoMgcV2kmNtreqCGAf0vsqG7EA8ZFKVASQRnd-CKVAYDbSoN66VkzAVezTycwCilLDn7R6z0cZkFiDOE0_ICxlKGcByC7xsFjHyimsU8MeNggQPHdAooBh-zpPJywz01PKY3TMRxzLBMJOjCtIxDIKxVixNRTEe4JlCfUAcr8koMRnhxCe7SaB6DiSMKcDUTN817T0JAMpw1CCvKMNJOhUAb3dOIAZ19xHLwUCpBp-dFUV3tzcVlDxA6sAuoJSAaiM5riUmszmo0Rn-KOYwMyDGNBsiaaeoppABEGVxaZZRDOlWoomb1NgMI2RwsZK4v8QT8hvZRTcyUpNcrVCHS-KKfA2BPhA3RAxaS6JIj-CCNpHkCSooZL-LG04wWuiCjgR0vt2LAYdaIxDT0VIGtpacTSohOFsvDE8Ti4gJlYIFY4jOaQFIuJ2fG-xWr0nsgZUa9ppTrWQ3epaIZ-zNgrx9awJKKHg3RRzCfNYa4EAICihvJ-h82sq0FVBFW0S2BHjsnhAeBiX5c7HmwD2GA1hC4nYcDmeJIr1CgiC2pbicJHAYqeLiR8C5XC6AwIEMF6gazy0u6Yu233EcxgS_d5LWOZmvcywshAH3QxhNWW1WGzLIa9XN782zWTdwo-WujhQjxOhDiYH2RmB5oyPBtw8benwAqliC_qXtqvcN-9daDR7T2NcvcIQboMxv4fhNxmTeQ0GZzHEBC8c5NS9xTNOKt9lt9Tj3IcPBs9q3dDYhEnmTRUBnNQAVXdIBcHrA3IGkz5bUhWdYHZ-FmF9hosq5w7FkAQfDiEbfW6nyeuE_-KT2Bzdz6d39mgzEODq-z22YyX3gfPWVwKFJ1gf4_kCr41zuXmLA6IOpa16IAjipqOAd-OJwN4cTd6dEJXqDzLN_Hq_rXh76TAH6K5H4n5n4UAoCX6oY05GLYb9rq4Qax53aP7Pq0gv4BzwC0YrqgafYDroqigfpvB5gJDwFR6E7E4kFfrU5zx1YgBQ7pAw7Na6ZMaMpI6daiDdaK5o76iY7fDpCSRPQFRmwZg-S5inA0Fk6YjVpU7kFzx05wjtrcwLRFILxFw15jg9ifK5xFp2Czw4ADQHi3wninD764jWDd4fCu4C66H4A37q7xZoGEoPZMHz5tyL5G7L6tR3AdRcGErAx9T3CJKvR7b8RO6h62Hu6e4Dje6ei-5-H-7k6T7ebO6OF5SR4FbR4hQeEuLELeGMZtZrLp4vrpzcHZ5gC54GzYCGiF7-YrgcoSzwGAGQZMw168r16AJN4t4JSMjhDogd4NqHjvg94WE6LCSd4fAZGQSpEZ4FYSBz7PZ-wZZeGUo-E_7b5_4BEwZHq_7AG96gGS6H4XqQHn4wGPRwFzwzGbEaT34uEgBP6x7_qLqv7v70af4p4r6_rr7_6watEIa76HFs7HHgGnGkGn7nGwHNHXGj5IF5QoGupP6_BYFqa4Gvb4FfZ5RfjsxPjSFYAKHYCuriG4lSEn50FEnSbZQsE6ZfH6YdblHEA8Go4UCmaSjZTCG45mwHgHDiTHCnBApsRVCajhFqBKG5h3KU6fKPw2A7L1q3IwnebdpQBzArYriFLjQ3HtacEPFJZYBUjUnLGtz5HvYbHEBZE7FW6yR-6hEO4JKRHQjRHcCxFYg-7BF2AIolhT6PDk65r4CkRBCORVymZh5j6EFJFR7zCPYolGl0ZvZZZmklGX5lHExZ6n5VGAKmZ1GDINFPyl4UxgqynVBfjCmSQBAvjOC9G5wvDyl3LwGuBCygjWA7hFlCn6JakT5eniSuqLEvovFxmJ6FFf7sHeLkSZ4lABmBBySiaTQcwDQRD-isi2bl4SR2BeClLPScinBbqbZmDFkLT6IIrcACjhDHZ5yjScmiEKIriNmfLaRyp0CUh7ltlkC7hzYwB04qS15WDQHQm_5WCPAnAoAhCVqIHXaQR7gsCBCkR7oFZ9JQWORJAsCwVx4rH65rHJ7kII5p7JnQaCkln6JlmmTLRaDRxM6U5dDWC3QPg_yapPDGAnxGFlhsjswYDIb9EZIrmDFYgal8w4iaLLiGG2Adn9D3Ez7ngZjP6xk0Zv5xn4HDnFE4UbKW47IEWagKDllfD0XyKijhSUWSRu4OC0VpCkVQCMW2DMWBCsXsXqycX1ncVDQ8zjQ6QCXeBCUiUKCoHiWSUxmoWvHYHokgZrpYmQTPlqWur4UHkhI0DMHcZaasF0kcGa6MkgDMm9b8EZCXl44U7hSfIUlYDikKlWpckykAH7G2ad6Kl5rqlOV8w-RoAlCqYiW3biUPbMGxmrHzJL5FEI4WkpVWnukDR25JLGj2nqDO5Oke7XneQJGDU-mYhzEy6h4dkWkPE5FbB5FzIFHrE9Wp6ewEyZ6VHVFZkF45nF6NH5mryFn7EaXEVgmjVlCSiVW3kulcWVkYj14-b9FxBwngWOpdnzEP6xJLF-UDkYWJm_6_E7FyG6GfBlVbFEXMUWD-D84cVVWuA1mOVqHOX8WqZuWiRGEdl35IkYHPE-r-VomyV4FroKUI6Q0LDQYw1fLRD_E3WaWGDI2qlaW2Xo0OU1XY18VSyCUE3CW_Vq4InPpeXEbImokICBVow02JXED00oUpVM25zw1AG3VI1kWo081vUym8UTS40GgGEi1E3Pq-UPFP7fCy04FU0YnBUDovWEma4PFM35Wf7q56h6kFAroKA_K3IFCNBxVNaiB7a-3vEgCSbhwhXh32ZM0MF5SimqAUQrrvAUCYCuo8EDAEHgD6gzj2GiA-LUQcb8j1Wli0k7GuglacZmxHZAhshNmPJBEFohlSA0g11SAADr4QIQBQLAtgamoAaALBOMDoftr2Md0mYA8ekEDEYmIACq3AvAIwUdPIwdsExAAAVAwfgEPWPcQAWj4qHpPYQtPXnXQNBOzPZvsP8W3RSFitkKyIYF3RpCojKTnYNf3TQGOJ4EMsQK-Sqa6gAROi4AUCJIEH4gFbJY1T7MQKXCicMEAAA";

test.describe("Homepage and Meta Tags", () => {
  test.describe("Homepage access", () => {
    test("returns 200 status when accessing homepage", async ({ request }) => {
      const response = await request.get("/");
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("text/html");
    });

    test("returns 200 status when accessing homepage with preset parameter", async ({
      request,
    }) => {
      const response = await request.get("/?preset=ipv4");
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toContain("text/html");
    });

    test("returns valid HTML with proper structure", async ({ request }) => {
      const response = await request.get("/");
      const html = await response.text();

      expect(html).toContain("<html");
      expect(html).toContain("<head");
      expect(html).toContain("<body");
      expect(html).toContain("</html>");
    });
  });

  test.describe("Meta tags - without preset", () => {
    test("includes title tag when accessing without preset", async ({
      request,
    }) => {
      const response = await request.get("/");
      const html = await response.text();

      expect(html).toContain("<title>");
      expect(html).not.toContain('data-preset="ipv4"');
    });

    test("includes OGP meta tags when accessing without preset", async ({
      request,
    }) => {
      const response = await request.get("/");
      const html = await response.text();

      expect(html).toContain('property="og:title"');
      expect(html).toContain('property="og:description"');
      expect(html).toContain('property="og:image"');
    });

    test("includes correct og:description content without preset", async ({
      request,
    }) => {
      const response = await request.get("/");
      const html = await response.text();

      expect(html).toContain(
        'property="og:description" content="Visual viewer for common network packet headers."',
      );
    });

    test("includes description meta tag without preset", async ({
      request,
    }) => {
      const response = await request.get("/");
      const html = await response.text();

      expect(html).toContain(
        'name="description" content="Visual viewer for common network packet headers."',
      );
    });

    test("does not include og:url meta tag when accessing without preset", async ({
      request,
    }) => {
      const response = await request.get("/");
      const html = await response.text();

      expect(html).not.toContain('property="og:url"');
    });
  });

  test.describe("Meta tags - with preset", () => {
    test("includes title tag with preset info when accessing with preset", async ({
      request,
    }) => {
      const response = await request.get("/?preset=ipv4");
      const html = await response.text();

      expect(html).toContain("<title>");
      expect(html).toContain("IPv4");
      expect(html).toContain("Packet Schema Visualizer");
    });

    test("includes OGP meta tags with preset info when accessing with preset", async ({
      request,
    }) => {
      const response = await request.get("/?preset=ipv4&controllers.ihl=6");
      const html = await response.text();

      expect(html).toContain('property="og:title"');
      expect(html).toContain("IPv4");
      expect(html).toContain('property="og:description"');
      expect(html).toContain('property="og:image"');
      expect(html).toContain("preset=ipv4");
    });

    test("includes correct og:description with preset", async ({ request }) => {
      const response = await request.get("/?preset=ipv4");
      const html = await response.text();

      expect(html).toContain(
        'property="og:description" content="IPv4 header (RFC 791) — IHL drives the Options length."',
      );
    });

    test("includes description meta tag with preset", async ({ request }) => {
      const response = await request.get("/?preset=ipv4");
      const html = await response.text();

      expect(html).toContain(
        'name="description" content="IPv4 header (RFC 791) — IHL drives the Options length."',
      );
    });

    test("includes og:image with preset parameters in URL", async ({
      request,
    }) => {
      const response = await request.get("/?preset=ipv6");
      const html = await response.text();

      expect(html).toContain('property="og:image"');
      expect(html).toContain("preset=ipv6");
    });

    test("includes correct og:description with different preset", async ({
      request,
    }) => {
      const response = await request.get("/?preset=ipv6");
      const html = await response.text();

      expect(html).toContain(
        'property="og:description" content="Internet Protocol version 6 header (RFC 8200 §3). Fixed 40 bytes; optional features such as fragmentation and routing live in chained extension headers selected by Next Header."',
      );
    });
  });

  test.describe("Meta tags - with PSDL custom packet", () => {
    test("includes og:title with custom packet name", async ({ request }) => {
      const response = await request.get(`/?psdl=${PSDL_CUSTOM_UDP}`);
      const html = await response.text();

      expect(html).toContain('property="og:title"');
      expect(html).toContain("Custom UDP");
      expect(html).toContain("Packet Schema Visualizer");
    });

    test("includes correct og:description with custom packet description", async ({
      request,
    }) => {
      const response = await request.get(`/?psdl=${PSDL_CUSTOM_UDP}`);
      const html = await response.text();

      expect(html).toContain(
        'property="og:description" content="A custom UDP-like packet for testing."',
      );
    });

    test("includes description meta tag with custom packet description", async ({
      request,
    }) => {
      const response = await request.get(`/?psdl=${PSDL_CUSTOM_UDP}`);
      const html = await response.text();

      expect(html).toContain(
        'name="description" content="A custom UDP-like packet for testing."',
      );
    });

    test("includes og:image with psdl parameter", async ({ request }) => {
      const response = await request.get(`/?psdl=${PSDL_CUSTOM_UDP}`);
      const html = await response.text();

      expect(html).toContain('property="og:image"');
      expect(html).toContain("psdl=");
    });
  });

  test.describe("URL normalization — 307 redirect", () => {
    test("/ alone is not redirected", async ({ request }) => {
      const response = await request.get("/");
      expect(response.status()).toBe(200);
    });

    test("strips unknown params — redirects to clean URL", async ({
      request,
    }) => {
      const response = await request.get("/?preset=ipv4&unknown=foo", {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(307);
      const location = response.headers()["location"];
      const params = new URL(location, "http://localhost").searchParams;
      expect(params.has("unknown")).toBe(false);
      expect(params.get("preset")).toBe("ipv4");
    });

    test("drops invalid psdl and keeps preset — redirects", async ({
      request,
    }) => {
      const response = await request.get("/?psdl=GARBAGE&preset=ipv4", {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(307);
      const location = response.headers()["location"];
      const params = new URL(location, "http://localhost").searchParams;
      expect(params.has("psdl")).toBe(false);
      expect(params.get("preset")).toBe("ipv4");
    });

    test("drops preset when valid psdl is present — redirects", async ({
      request,
    }) => {
      const response = await request.get(
        `/?preset=ipv4&psdl=${PSDL_CUSTOM_UDP}`,
        { maxRedirects: 0 },
      );
      expect(response.status()).toBe(307);
      const location = response.headers()["location"];
      const params = new URL(location, "http://localhost").searchParams;
      expect(params.has("preset")).toBe(false);
      expect(params.has("psdl")).toBe(true);
    });

    test("deduplicates repeated preset keeping first valid — redirects", async ({
      request,
    }) => {
      const response = await request.get("/?preset=nope&preset=ipv4", {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(307);
      const location = response.headers()["location"];
      const params = new URL(location, "http://localhost").searchParams;
      expect(params.getAll("preset").length).toBe(1);
      expect(params.get("preset")).toBe("ipv4");
    });

    test("unknown-only params — redirects to /", async ({ request }) => {
      const response = await request.get("/?foo=1&bar=2", {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(307);
      expect(response.headers()["location"]).toBe("/");
    });
  });

  test.describe("psdl-matches-preset redirect", () => {
    test("psdl matching a built-in preset redirects to ?preset=<key>", async ({
      request,
    }) => {
      const response = await request.get(`/?psdl=${PSDL_IPV4_PRESET}`, {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(307);
      const location = response.headers()["location"];
      const params = new URL(location, "http://localhost").searchParams;
      expect(params.get("preset")).toBe("ipv4");
      expect(params.has("psdl")).toBe(false);
    });

    test("psdl matching a built-in preset carries over controllers", async ({
      request,
    }) => {
      const response = await request.get(
        `/?psdl=${PSDL_IPV4_PRESET}&controllers.ihl=6`,
        { maxRedirects: 0 },
      );
      expect(response.status()).toBe(307);
      const location = response.headers()["location"];
      const params = new URL(location, "http://localhost").searchParams;
      expect(params.get("preset")).toBe("ipv4");
      expect(params.get("controllers.ihl")).toBe("6");
      expect(params.has("psdl")).toBe(false);
    });

    test("psdl with different key order but same content as preset redirects to preset", async ({
      request,
    }) => {
      const response = await request.get(
        `/?psdl=${PSDL_IPV4_PRESET_NONCANONICAL}`,
      );
      const params = new URL(response.url()).searchParams;
      expect(params.get("preset")).toBe("ipv4");
      expect(params.has("psdl")).toBe(false);
    });

    test("psdl with content different from all presets is not redirected to preset", async ({
      request,
    }) => {
      const response = await request.get(`/?psdl=${PSDL_CUSTOM_UDP}`, {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(200);
    });
  });

  test.describe("Meta tags - with controllers", () => {
    test("includes OGP meta tags when accessing with multiple controller parameters", async ({
      request,
    }) => {
      const response = await request.get(
        "/?preset=ipv4&controllers.ihl=5&controllers.dscp=20&controllers.ecn=3",
      );
      const html = await response.text();

      expect(html).toContain('property="og:title"');
      expect(html).toContain("IPv4");
      expect(html).toContain('property="og:description"');
      expect(html).toContain('property="og:image"');
      expect(html).toContain("preset=ipv4");
      expect(html).toContain("controllers.ihl=5");
    });

    test("includes correct og:description with controller parameters", async ({
      request,
    }) => {
      const response = await request.get(
        "/?preset=ipv4&controllers.ihl=5&controllers.dscp=20",
      );
      const html = await response.text();

      expect(html).toContain(
        'property="og:description" content="IPv4 header (RFC 791) — IHL drives the Options length."',
      );
    });

    test("includes description meta tag with controller parameters", async ({
      request,
    }) => {
      const response = await request.get(
        "/?preset=ipv4&controllers.ihl=5&controllers.dscp=20",
      );
      const html = await response.text();

      expect(html).toContain(
        'name="description" content="IPv4 header (RFC 791) — IHL drives the Options length."',
      );
    });
  });
});
