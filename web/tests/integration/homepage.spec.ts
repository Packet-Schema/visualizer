import { test, expect } from "@playwright/test";

const PSDL_CUSTOM_UDP =
  "N4IgRg9gJgniBcBtUBLKCQGcBOBjEANCAHYCGAtgKYYDKEArnpQAQAKE2ALoSJzAA7V4oANYpi6eOBSdMPYggCMANgC-qgLpEolTLmwp-nFBAVSAgs1z1MnCOWYBVACKsAtABsUIlv1K4fTmYAMw5mTl1jYgBzADoeUOxyUm4pfkwoD3kKIRAAYRs7BxdWHmwIAHcAIRk5eABmACYiADdKbEwTMxAABljGkFUgAA";

// toJson(PRESETS["ipv4"], {}) with top-level keys reversed — same content, different key order.
const PSDL_IPV4_PRESET_NONCANONICAL =
  "N4IgRg9gJgniBcBtUBLKCQDcCmAnAzihAHYgA0IxAhgLbYYBqehJ5IALjAA73ygDWKYunjgU7fG1LwALAF8KAYyrtsAcwi44ozjzZRsAMyoBXADbsGVMyd4yKUCIowBJAAoACHASLEPxExowPA9AFAIPNGxidhRDFGx8D3YAC2wPVKoDXA9DTRoVJOSC3LMzCAB3fAA6DxkczQ93TBkaxAAlADEAYQ8AdgBOAEYAXRAFVBEQFGSzKVpeEBcACQAZNl1eASFJsHFJCml5JRV1TW0QMyi1FP0jUwsrG14AVgcnV2i8Ymx2DyXsTIhFZXFJkDx0Kj4Ey4bBQCJ-ADMACYALS7X7lTRQRLhMrKVSJcqpGGFNIZLIeKLYjxUYSkjxcKgwMqZDzBNRCaoeZ4eAAUAF4PEiAAxsmAEgCUHiJUX8EA8EC4MRIiSoJK4MPwUXYAG56fkAB4oGiBDyDHnWMqVDwmLhJeUyUVgcUJBWGBVK3xc9rdPpDUbjKaTbGKLhzOgYAAiAGUum51txNiBBMIMOj9pQEAA2BQgfGnLQYDb6d6iSOxQx4bUoE5w6N4TAoRSurrQNJuCBCX7hfK4fiJFJpRmKfg_ADkiR4uBRyUV9Vw5TVUCEag8ijMkMSuWyAEUINGagB5RSKW3xAepG1cKceLNsvZu-mXNRURQwDwAFUTj_ruEbzYVRRVF1DxRRQRJgnwdgUSMbd2FaToeiRGRehkAMyAmDBsEUUgDnmDAAFEugAOQTPQ-GTbY0z2KQECRXN8w0QtREMDc1AzRxnFEAiDS4Mwm3EDxW2INQEmVPxiIgGI4nxXwwg8S4JA8XAIBMVQCA8Qg1GoMw1xIUSoLk8pxFnNSPCgFTrxXBlX1HCQamFYV-WIKSPCI4iUWURkwEuMFhUGAB6QYnPczyqG8y4klwWl8C4TR2DBQZBn5RR9LEuTsF4vB4mIZs4V5LoCIlBDfQRQYswADnQzCdCk6xgREm48IjUQPzq3SGuuZIyKTFNJi7Nh0wQcqGJOJjzkuRrureLiQDa9hrAUkFkkfQdzJUKg1Gimg-XJEI-JMRIoA2qUhDFAkagAWSEY1TRFXaAQpEgzBgCU9UNW6dqzZ5ngRHlCFytI1ribAzDhcCzTvdNpUiEqegGEYxgwoMMEiaJYibFRfHDBYXAMdGZKx1gKGLCi-tR6JBpo-ARuOVRxtR_HpPiXAS1mvHqxBrdorUOhogvApgjKET7XpfB5gVXAUA5HT1oWrbaE0-U1phZsUG8NdaWUgF8C1IJIsHGgagAQV16XvjhZ0xapEJaThfAihhS330tHIeb5pSIHdEgh1sn44b9RHA3J0QttUsMKDQDBWM2_AACEaOahYOjYjNFGSFAwZhaRkBRljU4AfU1BtYRxjA2h6hAtlTUQhoOYbRvps5o9Ttny4SEu4Rj1ce0O35glAgOEeqvOQG7_AC6gQwy7LDpK7Jqja8TzMacbgtznHtuyxIMdfg6d3tXkmU_EGMEVLU5hwT7uVfkMA_onpYc7JpOkLLnQTeRhdhoWIayXC6S6bhTrukEplZssILxpG-AaX4_FiD8AnB4S6H4ACqNQUFamdh4NwKgVrIJQR4cs-BUreBgEPIYYJEJmkGP6JGNUx6FxoNPJOGBLpzxJomKulEa5iAkLRVedN14t1jlvEAl1NBpH3ptD2OIzQKj8NgUhbtpGHzAdgJUT5IQJVAvI-kcRZa8gaM9V6yjebajBKoUo1kVbYWwOrEIx9tabmwPrd8ENUo0D4j8bA5Cg7DEDFHFiPNDyGEMFqdgM8QBSLMQ_EJYSfjz2rjsZe0hBgIjXgzUQaNmZ4FER2Qg4lVoZ25io6IiDjoLRhikM6a1NDSyEItCpm1tpglSiYT44M_AVTRC6G0v97I6O3HolABBb733gh4H08NaEBMmOwdgswWGtQ_GsDh5EkkUwiRQIa8AKoZOblkpmGNckzQwB-Y0aQ2oeBWPY-SBhFAwg9rCMU8i0gFABOnZSql1J6jWk_H4EQjrgWULgAw-VjIpBfo0ABnhzl0DcgacBYKpSOMEjCV8qREjCjBBqRR1YRbnxiCLMoipvRUOHnQ0eGopJOAgIsyg-FRBuBUuwWl9LSYbKyZTbZ1M9mCMyRwThpzRAcwJueek0DoKXBwLpalrLUq6RBVLZ5NTLyMmZBATINRWw0BoCQLw1hbCJGSv_QBYIsz8g_HGRKvR-QoMjG4XxYIXDG2IsbbBLK2UeGIoEYIBAR6BJAHtXAXRUgjihDQSJ_xATZFDdhfsgREncP6ty3hkgaY5n5QcvMYaE2RuFSAcqaJBI-wnJ5CAnjLgezXLmiNelPEXzhBADWa1g3yJenyFyvw_lMhZFAYqHg2jYQrVwRtNJfgfJWrOO0wRlCHSBpeD8Kya20gMr4gNkx8C4EUMbKAFlInRlUtutIu6LIJAzBy5NmyqZ8PgMifZzEQCZDPWbESoimh1GfZqRIXtrbCDwOuylgbsTsFPazJZIBIzpWoIUsD56k0hymKmnZ96s2Pq_eelc763DNBpHu79RS0hdhtnCVWKAuA5QmVMwOI9EOQHaWCtggbFTiXwMbdFkTDyehVB4djAJBounTZykAio2CidECiNgVAuGIdExQcTIAABUUmZOLxADCZhY94hg1RjMJG4BVM8P4lsrAhq7ByFzGAQzkxjNsEwGZuiwoLMFs6ikFEBh-I0HEM8mEHJ9WzjBtYy8H6PSsbBPR_9WC1rLBWDkbTUB4CNFWB4AA67UDwgAkIiFE6QTNQPyXhY3JGEPACi4HaQOZWl4qRFIhsQxU2BfnRUztZAiwgURexRFx8SKIblQQ8AFGye7rLOgJIUAoLlQtyQMMQqWkEaQkioGAfAmhghRcvHVngbJVLCDVGQyZ5KhgeAAOUIiqIjCgIMwbptzoh4rAITPMe48QDM1AWogC616NgjFs32aloty4X3tsRNENgCAHFSwgAAFp4HlA0PVJIQuFZVGCSd5lgVSy8zB55VsHyXEyNZJHxAUQbHOj4j1HcH7GOlKkPwMWPAAD5uS-OO6d87IBQYuO1Fwx74kh2pVBWwS72IEA3bU_gCF6cmM7BgF-PQ8npDCZ4NgfgN7018pAJxDA9ZLhAUgZN_VG4YDfLdhWp8j0CdPeJ9-Eb2AcXYGV88iFplfipWe4Eay4g9So7VDtGEKJ0XUkEpCCISk4ijLi6DKAzOTtndGMcLUQmQDCm55MUH9LNfcUPLF3krWm3ug-_q3r7AJSC_i9d-hxYIOy-wPyZPazepqbrivdX33H2V41xDgvfgSc24cuCNU_Z6S58fF3654EQK0nfIyIbIsqCGHUiHq8otW2PRCBF46WhAURG0hIqP-3fQUrkP4iggwU8YBchHDvs1iKHk8LySSHguN4CJsQEvF2y8i4r0Khlb3q_8lP_XtZtRHwvXLsg-ucO3hnu9k9kkNbi6DUIMFvlQN6hAJ1lOC_oNq0hWnqsQB2pyHgKoHCKyjSPxNpDSPUKUBUBboUvqsgciMWv3NthvnttRofsfiAL0GfqIKrFiG0N8vQAWnzliIOvwaXpHuXqPO3q9gsH_pwYAQvDwk3tIC3mNNmpAZ3jAT3i6HqL0JpBzrroOsOqCiIRfGCESE2CtAqjrkpNFjhp-vhueo-KjoSiEGtE0grDtOwNFN4AnoBrMhgJNF1JEg1P_s8Aho3ikggCoU3I-oEU1Ffmcu1EtFNDVj-jAWdDbvgGCEIOuCYMuCLGtBsGCHEckGCHbAyJ2J8NkJkX4cjIGnFMRuBj_gsG4F4eEYoZEWAWhucNksck0VAYeN8GiJCNjr0l7PEt2pVlAplGMvbnhi-okPgGUL8KqmkITl7hitrPzvkauC4dkJkPZoDIkIJFbC0PvtMkHHUZMF-nXs0RgGBmaO0SmiZihvRN0RgBhq-moKIkIaCs8iFp8YscsfJHEKUCqn4FbMgXsTSHru4dtDZLrK6CkOfGoMkLUfQl-gAXcaIA8UiE8dejyreqhnmKoehg4V8T8UYWCo0HYfMQRksa5OEKCZcJ0i8lCfwfsbCRtB4QiQnoUCiWiecTRkBtcfhniRBg8QiPiVyi8dTMSa3ucICVhoIVSf8bSYCZpMCUyZnCyfCGyV8hfJyfSHCYrIyIiReAKX4ewZVFwRwBclBLQJflAXCmJI6WIVdp_pId_tIWcomPyDafIcJkoVEeAUWN_gMZoXAaoHqJVHodYXri4FUd8L8C6Q6Z4vrsQGYRnJ8jwaCnrjEPCs4RyekHbLqW4dydtOiaPCUcEVEP_uKYKuslekvCAc3qGaIDWQWvNItCUakRmXqZkdkblDYDsfSEUckV1DipUepGUXSM2ngKxBUAFN3KTmSgfjMlcRgA0VUZEq0U0ZenRp0dEUIocpzCzKIoMdgMMZgqTm6BMcvpeJKm7HMQWa6emQyRPlAIcXlDCZSJsdCbmYHjYfaQtJ4lWcxqxOUKxN8RBiEmYOUAFCnDBY2Q3h0a2coe2QwiIgWoeN4IueUHpO0r8LyBnKielumFKL-nsQLC7qpGDDfPMeQa-WmVwDijYKqLUAwTkGxHGdhESquDYtsdZHqgYHyMxaBVwD-rgTAGYSZAyJqDwIoMcnCICQkCjuwIoFUAOqwRuRXvgLcT6a1NGI8YGc2UhrKUSW8SSTET0UciDP0RDqmRJZqa5GdF5lYlqK7tSADABCglauCGgL_Kid2NKFLPMrKJCQaQvsHuWfLPCWaXyciapKieBXMvgFiYZXNMZQ2QeWpgNISemvKaSbZWeScgka1CBY6S5SsX4O5fxJ5SQN5TkWkH5T0F5lAEFckCFeUGFaoBCS7FFbbFyXFaac4haclYKTpX4rmGkqfhRIGiSlqIetCM2HwRfKIisBAGDmkMtceiYaoO6cLkgF_nLtiXNH6bNdKWmvwseQKuobNKPlodGWaGVLxQYZtdtR4LtQBOUb8XCGtaoFmVWE-OPs8i-KoIuDAIkCaH1gPI2AUuCZLBSGAGZFJMSOkKSv3u-E4KeNUT8OUPbt3qkEbEKYfpuR2ctLWcQP_liblWhS9iGe8RTVNKIt2bpL2b-tUmkYUhkYJkObkaOYUYmMUctLOXCNuQvjUaTbpVStOWVZlXuVdcGV0dZSeUGKVQ5Q9UMWACMc7KoHeeEg-dMTAoNXSY4cQQPNSs2IiVAHqAcbSD-acb-ajvVYQR4ODdgJDVvuiunLCKlR8fhgZYyiAA8bTZwgoc8arggEVTZQHQscqeVYsOqeST-u6MgR7V7fqmtMtitVebFNhMpYNf7aIJiZEriVdflddXelZQqXHd-gnVAQCSnY-OnScJnUTWkDnceiiPnUpSDKRvwVaTNQiJwfNZul4U2OwN9dgADQIYndGBPUBF9UegBLPYdRIYGlIcHX_mknIShUAS2QzSrbXToOGRoYUk9Q1i9boVqPGV9Yvb8NPS_P9VSftbbtTsDbFc0orDDf3GkNuIuH8U2tJfyRNfSJlK-L8BnUyIkK7bCEOUjQBtLZcfQp2WdSEUlErUeZhWg86UkRze6Fzf2bzQSPzSOUFkDMLROaCM_RUY0aucXSABLfLcHYraZYeehYzarQKr0fZRedrbrbeeMYbcQWtE-S4WbbrKLJbSpNbZgnbV-Q7aMelsHi7aDXCNA24okD7akHvlNRunXUHW9qHRXchnKTXcVXXZhm-gWk3QsS3e7W3UyLotnSvXnYpYXS4Yw6XRKfhkKKYxZYVRY7HSXSnQ3RDnYwRr-q3RDc41netm4z3R4_3UXcgwGP4hZhk_4sMA4AkA8uRuJK4LSW2ryAdoMFKOEHThZPYnrl3rA8tFUAJqoIeH8azKIHHARGwCpOUAnJZRBiFtGlkHZswNjKIMKFUA2duPkMDkw_gFALMHIEAA";

// encodePsdlParam(PRESETS["ipv4"]) — generated via tsx at build time.
const PSDL_IPV4_PRESET =
  "N4IgRg9gJgniBcBtUBjAhgFwKYHMICc54QMYAHLEAGhCiwDM0BXAGwwDU0WnL4AWGlAgoEIAJIAFAAQA3LPgDOASwgA7KaqYBbMPKmAUAilK6qjEvpKsCqRgAWWKfbR18U-gS2Ybtr-5YsIAHcFADopPjcCKUkZPjDEACUAMQBhKQB2AE4ARgBdahBjUTlFFVUC1TQtXhB2eWU1AtIKBFAAayVVKFEwJQwFCoQ-AF9hqlRMXAIiEBYsVRw7ArpGVg4uHgQAVkFhUTFTeVUsDCkACSxnPQAZecXbKilqtAUmfCwoI3UAZgAmAFpeqdAgQoNZDAF0NhrIF7O9vA4nC4pPMwVI0F0EVIyGgYAFnFJdDhOqEpFspAAKAC8Ul-AAZCTBoQBKKSw-YaCBSCBkMxqaxoeFkd4KeYYADcWM8AA8lFptFJsuSuAFglImGQbFy-AywEyrNz6NzeWVSYlUhkcvkaEViEpbCwKlUamIztcmuReO1Ot1iECBjRyvxRuMQFCpoRRM1KLsRMQACLmejyMVKSafADK8hkShQBpS0AcEggnVOhk8-Da1jsDhxKDaJwA5NYKPh_rYeZF8IFBVBOjgpCgWC9rO5XABFCAZsIAeRQKA1lmr9nVZFbUgAbIS-tYIEaa1I5jg0CgYFIACqew1SLP4HN57kobASqQMpTWXQKDD_BhjjDxZI0l-Ph0j4a1Cl9WgFBQMgnWqUR4wzFIJA9Fp4G9Loeh3QZ4A3EMJmwPBI2IehhxwANaD2YgAFFpTIFhcz6KQCwWKw-XUAA5CAzAsKEygMQ8TmsfAICYbBFCkZQcEqFhBzUHA2P4wI-g7MSpCgES137bETwbfowjpOkqVUbipGolIOP-dAcTAOZHjpbIAHpsiM8zLOstBbIcDB8AxBQyAIDBHmybIqRQeTFLUFE6PkSxVDzT4KRSajmQAi1vmyDcAA5wNtEAsBQcpA2dUQ3NQr0QA6TC_WwwMEF-fCw0mIiZjmBYlljURz24rhBPa2xrwPKBMDQHBfK0SkkT0eimGsYaMDQVlOkZaEwgAWU6OUFXpSbLmRNQWBgZlJRlLaJo3LYtm-cllHi7yVwsLAWE-d9FS3f02WMLA0rSLI8gKPKMB6lhbn6uCam6hbZNB-5ytacBsPgTKaCqyDSxARrwxa0QvtMcxLHwZYqPEEweKXNxfJwapTGXLxdACBYtSxBRnW5fAlGJGT1JGsaqkkrkD3ePMlBKQcMSkd4RywHQ5gRLQwgAQQUKTjk-PVmdRPQMU-BQfHeNWzxVCnRup_przUWtdJOH7LX-m00dJ_G-MaYr4OIMRHd4zAyjh9CEf6BBkcqn0cdMDGxlQWwlGe94g2QJrCOmURSNGiihDjEAEisbMPjcMiBPlL9CQcOkbb-3LIJT8iAH0RRz7pXZqBJfYwyD_Rw7JMeapOSLItPifjNRG1OJJKdNgT2XUbJHhEsT6ieWbThM056DHsUsTrPT0UxDTOyYil3gwN5VG0sQUjWiQlqNJisGlPMPmXBxjmlU4GNUNpmykNbzwAVTCH_RQGykBITAA1v4_ykImaCEASgwDLjkR4gFFTZCtADSufdq5QHoODBCSQW7B2qv7CiQZO4RwThGGYVd-4ZzWgQBwo8TZinBIqbk6gsCwONlTdet88y8ixMOL89lWFYgsFzCkUQDpHU4abR42B_DaUFgVLAIs9CTwlpcZW0tbJnleuFLQ9ETjfSkOaX6qD7bJwwVobBjdRBrTwTQaM8NUZYQDnVJGoxcjmN7qnAAQrVAhkExqiVgjY4gSQ-4Y1DFjHuEFUyPUJp1YgxZlDsUGlHUca9TCf3mmgT6dhloHgIBzTovUcm8y0I8cKTBDgvXUFlQE-p1Qn30q-LsIilCKBXpk_8xikHlzQcnSmM56D0FFBgHBYTulSGGaMk4-DnE1VcSAEh3wu6J2IrEvG8SiYZ3PHKBw3UpDXBUQJOgKB3im1zurC26JTiXBQANWe4lJQHk3icIwc13zoHwHQRKyk7Db2iOfaQezqhmTvlgD4HxWRqKYpLB5Bo6SPGFOw1MjMnnaQCDyM0fSzEQSjBgR0oSQDnnPO6Bxnp4bt3gFlFGIc7RhzWRQqMlLEkkzieTA8z9vxzDkLJYU3FhAQFkt89mucCkrhxHiCAzgwgFi0FoKKMgNgGlCmfC-jwNxUnPMhYK6QqQ_3jBIeB09ogKw4grYBIkgbhVkhxbQuhFAV1EAKm1wqJkgAkNaoVRKSCUr9tS2lATQ7jKZdjYgCL6yvC0Ds0QmVARMQts2KyEB9FzHHpGqsCo9FkDnp8GBegDxTVcJIyky8N64nxFAVKUgs45rzbclEJ4Bodk1LodAs17oHLJYOHwrEcUWn6V4kAxaUj2CjdoD1FwriuDHQVLNMaKVoVANSoOCzCiMrIdEjZzgNJWFujgWN7sJCxHRFAPdys0kOFFF0eQJrnXEAUPgFACtz0JOWSVYgGZRLPocK-i9FFHEBsRn8OlhD0ZhpibukUB6j3iBPREaD-6r1fGwLez4QslBkDij0kxtsH1QQwP-99lQ3YgHjIpSoqTiP7vwdS0DwaGWhrIXqaE8M0Dsfho9Z6OMHQFHXe8bBYxwBOPpbMPoBRlXcF4CMMDkEeQFAU8QAAVJEkTft10MXGTQKTmx4D0mE-uhTNAlMgH-Gp9OogYZ2H-HQBiWg-i53eMSKKHZnoKJXDECIPJ2IKEeJAapvzGRYldNcNwlhnrwGiG6KQAB18IUhABIRLSXU-pSTnhXD5_i7wKBeHwNU6sAsVyojSa9aBFAXm-WjtpaiXR_h7n-DOE0ah_jHKLo5HS57tKsYNHYLwJljSpLoNBdmn50Twk8goAguggEHnKw4ALXRBRwN6YOnIUgADl3wQh2xANxsECB47bpmMq9mnk5gFCqWHYgWAIDUNEAALXkFyKIir4RecG6aR49yBp9hG3KEp2AgE7kEs4bSWWWvRhWkYr12dTCsMOmyew6hQtSAAHxkhNZt7bu2nrSzFFxiLB2kATFFAMP2dJ4aWZojOMLFJav5qNE11JbWMDMgKPt8nR3u4bMcWy5n_Eoc9YMk8QUVYsQM-vALqKrPJQYjPDiLrjM0D0HEkYU4GomZFr2noRbw1CAfKMNJOhUB70DOIHzj9ZHLwUCpJTpdFV13tzcVlDxw7buOmE9kKnxMOIzmkBSLi0zWzezUOzmgnPDsEWZRb1llEM7S_UEL_UYRsiG9yVxRrIfUmK8qamxVqhEcknkEDpmXAObqFyX4VU4PmvqCirkv4CbTh6-W2b4dlvSMQ09FSb3DvROEOd8shArvhiePxcQEysEvcZR9xna4EA7sOG_W8B8CRRLYA50Trn0fw1-paPzuvNgrw9clNkDKkk8dPmsAvpfN4f0Pm1rWgqoJa0b6wI8dk8IDwMS_LnY82APYMA1ghcLeDgOYKS4q9ePyuuak3EcIjg2KouZ4wgC4rgugGAgQkKSe9g8sq2piu2gMceXeXUPe5-fe--juYmQ-QYo-USPOrUdwHU8eXUwMfU9wpWu4R-y0PWfmXwQ4TAfYjMB40YjwbU9wjwT-AUpYuuaW7eE-swTBtgHqoMveFBQGrcLixCI-kGGyuMZM8gcGM4xwgILwVyjSe4sypwQMWI3KEs7-Z6AGTMug2IIkeYmiUAcuUAyqd0QCiG1gP2h474peABWAQBhu8K9gpu-B-G5uIA0hhwJGn6nqPk8y1B_itBuhMwSGys_YcGH2ORu4RouSoR4RUUc2D-WA_w_kBU-MTm7-8heU0G9uVuNQxGiodGIGvwcmIa4c9B6y2Rb6-6eRbKBRQxl6e46IUgpRuIwiFRq-VRNRKAdRGGDRMRQ6Ch0GFBJBxA7RvwnRAc8ADG66EGY-w6WKooK-v66-c8am5-6Qc-ogGYPkuYpwVxa-7-W-T0xO3OAxLKB-LBxAiex-FA0OZ-3w6Ql-cw1-N4LxT49-Cx28nwdar-Nx2An-cIXa3MC05SC8RcLhY4PYMB-aheZ4dgs8OAA0B4t8J4pwMxwBQRf-UAjwy0oId66xeKRBAJOxJKZBEJaRg-GROhW6DBog4hzB1OJKbB4pA0kx-SXBqSPBaWLJ8U3AQhA4IhnoYhShkhmICRauvBjRkEMpKh8wahApbcQpNKWROMnsBMRhJhYAZhBs2AhoVhWuK4dhTyDghRzhtYbh-6HwXhPhCUwW_hTaDyjJIRkw4Rr0kRHwRpLqJYiRHqEgqR_eGm6RSymRIpfxxAhRIxgJ8Gp6vpkxJRMZsx5RK4U2Cx1RFAyxj0qxc8iZ-Zb6LRPJ7R6h_qK6XRPRTGfRu-UG4xsGoxCGjhMG145ZgBlZOB16lRdZtRjZ9hzZHJhBkEWxHqexBx5OxxYmpx4-eUX47MT47xWAaJlAwm2UjxxAoKbEVQISe22-Ue5Ce-lukpwJye2Ako2UUJBUZsB4Bw4kxwpwt5X495n2agGJuYjyL-Pyj8Ng-yEZjy7-rgfaUAcwnwQ0PM40LZlBHqNuWAVIV5GZmhiy2h1puZMeihYMbKkMvUMpnBEF6gSp0IKpAh6pWIoh7BdgyKyZ4kup-aJQpEQQjkVc0OA6BBBGJpxKqh2Q-xJFjGRCOEdBg5ehdphh_Ojpzp0ObpYyHpT8t8XSkKCF1QYF-ikkAQL4zgIZucLwSFy5auQsoI1gIOZgplC0-iuF-pGlrRogaZ76GhilNBwp_RVFVCRhQlqock1SpwFIUclJCW_orIkx3pEkfWpwVSz0nIpwu6Uxbld5-iyK3AAo4Qzeeco0v5T4HmDgTlPy2kiqdAlI-VZlZAu4pJn-KkrhVg9ZKx45gZfBJwKAIQNaeGGxeUe4LAgQpEh6xKwyk1jk4SM1eFmZgp2ZIVqlMw-hdR76kpoFHlmoCgllXwTw0cv-L-XQ1gt0D4P8OqJ1UAJ8lJZYbI7MGAaGwWuSqV6I8FZS40Okmiy4FJtguF_Q7ZyR54GYHRCl9G3RilpxoVe-W12ytF-yLVFlpky0Dm8ioo4UF1kknQ11t1Dm91HMtgT1gQL1b16sH1KFX1WIP1fMOI_13ggNwNCg2xYNEN8ly1PZhxu54Gm6B5kEzV-1amDxfskpKJPyb-txEeT5JOL5MSb5xMH5J--okokJoo0JZsktyJ7-UFkZtqWt8FYxThkxgRn1WFOJv1PkaAJQZOwNxBYNPeDxClTuVpKlCtGy0lRZdFskDFcp6STFx1vBbFap1VIJH-3FDwSJ2IfFshq0q5UlShppqgveWwFpWhylNpdo6lO1ytWlgCOllhelNhXKhlFMxlvph16Ns5TFko5tsFHFn11lGI7h6uYZXlcdSRZG_lGdZFWdlFe-BZCwcGOtucJtE51dT1Fg_gUB71DlWs312FDNUsANoklJuFzRm5b6kN3NSlRxMNJxm68NQ5AGhZEtjd49Y5VdR1hgM9GFwdhsC9rgdllto0v1jNZOzN69QNidcRG5xKW5UNvZsNx9G1ogw9S1F94UxJ0Q19w5aN09p1c9VNz9tNb9uJn9vWtgLNf9w60GXNHZO93w25CAfNaMAtw6tVUA55fRRZWYRtWIEO6gw4MAG-FMqa_Ce0te7E_wn5kdFAWADYnw_yqkGV_I2g2kfQ9dza42E07w_wksaITEdlIOFgnS4W3xWOW2O2BGeoBF_GYmCg_yDyimQYPN5OQa66gjbQ4cgtogzDOtam41deFEAmWAuW2mvlQJrjGM9jxAzDCgCskshjg-ok6GHqie1gwTlwfjNAPWM4MBhMxAPi1EywVg5yWG7E-wY5xalIuK2QrIhgqOGkKi8FUTUdIQHOHgmALqCg6FHqH206LgBQIkgQfivNMNdtPsxApc-xwwQAAA";

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
        'property="og:description" content="Internet Protocol version 6 header (RFC 8200 §3). Fixed 40 bytes; optional features such as fragmentation and routing live in chained extension headers selected by Next Header. Addresses are transmitted high-group first; e.g. 2001:db8::1 is sent as 0x2001 0x0db8 ... 0x0001."',
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
